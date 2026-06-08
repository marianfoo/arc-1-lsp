/**
 * The arc-1-lsp engine — a thin adapter over `@marianfoo/adt-ls`'s `createAdtLs()`. The
 * library owns discovery, the TLS reverse proxy + truststore, the driver, reentrance
 * logon, adt-ls MCP federation, and session resilience (relogon / revive / keep-alive).
 *
 * arc-1-lsp keeps only its own concerns:
 *   - the BTP / Cloud-Connector path → plugged into the lib's `connection.forwardProxy`
 *     hook (the bridge stays here; the lib forwards through it),
 *   - write-safety → re-applied here as a thin wrapper, since the lib does NOT gate
 *     writes (consumer policy, ADR-0012),
 *   - foundation mode (no SAP) + non-fatal connection failure → the lib's connection-less
 *     `createAdtLs()` (adt-ls + MCP up, no destination).
 */
import { type AdtLsClient, type SearchReference, type UserRef, basic, createAdtLs } from '@marianfoo/adt-ls';
import { type ConnectivityBridge, startConnectivityBridge } from '../btp/bridge.js';
import { createConnectivityProxy } from '../btp/connectivity.js';
import { lookupDestination } from '../btp/destination.js';
import type { BTPConfig } from '../btp/types.js';
import { parseVCAPServices } from '../btp/vcap.js';
import { warnOnAdtLsVersionMismatch } from '../version.js';
import type { Arc1LspConfig, SapTargetConfig } from './config.js';
import { logger } from './logger.js';
import { type WriteSafety, assertWriteAllowed } from './safety.js';

export interface EngineHealth {
  adtLs: { name?: string; version?: string; up: boolean };
  mcpPort: number;
  connectedDestination?: string;
  /** Last-known SAP backend liveness (a real round-trip succeeded). Distinct from
   * `connectedDestination`, whose session can die on idle while metadata still "looks"
   * connected. Refreshed by the keep-alive + every search. */
  backendLive?: boolean;
}

/** The lifecycle surface server.ts expects (arc-1 method names), over the lib client. */
export interface EngineLifecycle {
  resolveAffUri: AdtLsClient['lifecycle']['resolveAffUri'];
  readSource: AdtLsClient['source']['read'];
  createObject: AdtLsClient['lifecycle']['create'];
  updateSource: AdtLsClient['lifecycle']['update'];
  activate: AdtLsClient['lifecycle']['activate'];
  runUnitTests: AdtLsClient['lifecycle']['runUnitTests'];
  deleteObject: AdtLsClient['lifecycle']['delete'];
  generateObjects: AdtLsClient['lifecycle']['generate'];
  validateObject: AdtLsClient['lifecycle']['validate'];
  findTransport: AdtLsClient['transport']['find'];
  createTransport: AdtLsClient['transport']['create'];
  listTransports: AdtLsClient['transport']['list'];
  getLockStatus: AdtLsClient['transport']['getLockStatus'];
  assignTransport: AdtLsClient['transport']['assign'];
}

export interface Engine {
  health(): EngineHealth;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Repository object search on the connected destination (returns the references). */
  search(pattern: string, opts?: { maxResults?: number; types?: string[] }): Promise<SearchReference[]>;
  listInactiveObjects(): Promise<unknown[]>;
  listUsers(): Promise<UserRef[]>;
  lifecycle: EngineLifecycle;
  navigation: AdtLsClient['navigation'];
  quality: AdtLsClient['quality'];
  services: AdtLsClient['services'];
  /** The destination connected at startup, if any. */
  connectedDestination?: string;
  /** Force a SAP re-logon; resolves true when the session is live afterwards. */
  reconnect(): Promise<boolean>;
  dispose(): Promise<void>;
}

export type ConnectionPlan =
  | { mode: 'none' }
  | { mode: 'direct'; target: SapTargetConfig }
  | { mode: 'connectivity'; destinationName: string };

/**
 * Decide how to connect (pure). On BTP (connectivity bound) a destination name wins →
 * Cloud-Connector path. Otherwise a full local target → direct. Else none.
 */
export function planConnection(config: Arc1LspConfig, btp: BTPConfig | null): ConnectionPlan {
  const onBtp = !!btp?.connectivityProxyHost;
  if (onBtp && config.sapDestination) return { mode: 'connectivity', destinationName: config.sapDestination };
  if (config.sapTarget) return { mode: 'direct', target: config.sapTarget };
  return { mode: 'none' };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Wrap the lib's lifecycle/transport with arc-1-lsp's write-safety (ADR-0012). */
function wrapLifecycle(client: AdtLsClient, safety: WriteSafety): EngineLifecycle {
  const lc = client.lifecycle;
  const tr = client.transport;
  return {
    resolveAffUri: lc.resolveAffUri,
    readSource: client.source.read,
    validateObject: lc.validate,
    findTransport: tr.find,
    listTransports: tr.list,
    getLockStatus: tr.getLockStatus,
    runUnitTests: lc.runUnitTests,
    createObject: (a) => {
      assertWriteAllowed(safety, { action: 'create_object', packageName: a.packageName });
      return lc.create(a);
    },
    updateSource: (a) => {
      assertWriteAllowed(safety, { action: 'update_source' });
      return lc.update(a);
    },
    activate: (a) => {
      assertWriteAllowed(safety, { action: 'activate_object' });
      return lc.activate(a);
    },
    deleteObject: (a) => {
      assertWriteAllowed(safety, { action: 'delete_object' });
      return lc.delete(a);
    },
    generateObjects: (a) => {
      assertWriteAllowed(safety, { action: 'generate_objects', packageName: a.packageName });
      return lc.generate(a);
    },
    createTransport: (a) => {
      assertWriteAllowed(safety, {
        action: 'create_transport',
        packageName: a.developmentPackage,
        requireTransportWrites: true,
      });
      return tr.create(a);
    },
    assignTransport: (a) => {
      assertWriteAllowed(safety, { action: 'assign_transport', requireTransportWrites: true });
      return tr.assign(a);
    },
  };
}

function wrapServices(client: AdtLsClient, safety: WriteSafety): AdtLsClient['services'] {
  return {
    runApplication: client.services.runApplication,
    serviceBindingDetails: client.services.serviceBindingDetails,
    publishServiceBinding: (ref) => {
      assertWriteAllowed(safety, { action: 'publish_service_binding' });
      return client.services.publishServiceBinding(ref);
    },
  };
}

/** Build a CONNECTED lib client per the plan (DIRECT or Cloud-Connector). */
async function buildConnectedClient(
  plan: Exclude<ConnectionPlan, { mode: 'none' }>,
  btp: BTPConfig | null,
  config: Arc1LspConfig,
): Promise<{ client: AdtLsClient; bridge?: ConnectivityBridge }> {
  if (plan.mode === 'connectivity') {
    const dest = await lookupDestination(btp as BTPConfig, plan.destinationName);
    const proxyCfg = createConnectivityProxy(btp as BTPConfig, dest.CloudConnectorLocationId);
    if (!proxyCfg) throw new Error('connectivity service binding missing onpremise_proxy_host');
    const bridge = await startConnectivityBridge(proxyCfg);
    try {
      const client = await createAdtLs({
        adtLs: { path: config.adtLsPath },
        connection: {
          systemUrl: dest.URL,
          selfSigned: true, // localhost TLS proxy → forward through the CC bridge
          forwardProxy: { host: '127.0.0.1', port: bridge.port },
          client: dest['sap-client'] ?? '001',
          language: 'EN',
        },
        auth: basic(dest.User ?? '', dest.Password ?? ''),
        destinationId: plan.destinationName,
        mcpPort: config.adtLsMcpPort,
      });
      return { client, bridge };
    } catch (e) {
      await bridge.close().catch(() => {});
      throw e;
    }
  }
  const t = plan.target;
  const client = await createAdtLs({
    adtLs: { path: config.adtLsPath },
    connection: {
      systemUrl: `https://${t.host}:${t.port}`,
      selfSigned: t.insecure,
      client: t.client,
      language: t.language,
    },
    auth: basic(t.user, t.password),
    destinationId: t.destinationId,
    mcpPort: config.adtLsMcpPort,
  });
  return { client };
}

export async function startEngine(config: Arc1LspConfig): Promise<Engine> {
  const btp = parseVCAPServices();
  const plan = planConnection(config, btp);
  const safety: WriteSafety = {
    allowWrites: config.allowWrites,
    allowTransportWrites: config.allowTransportWrites,
    allowedPackages: config.allowedPackages,
  };

  let client: AdtLsClient;
  let bridge: ConnectivityBridge | undefined;

  const foundation = () => createAdtLs({ adtLs: { path: config.adtLsPath }, mcpPort: config.adtLsMcpPort });

  if (plan.mode === 'none') {
    client = await foundation();
  } else {
    try {
      const c = await buildConnectedClient(plan, btp, config);
      client = c.client;
      bridge = c.bridge;
    } catch (e) {
      // Non-fatal: a logon/connectivity failure must NOT crash the server — it comes up in
      // foundation mode (health/tools available, reporting disconnected) so it's diagnosable.
      logger.error(`engine: SAP connection failed (server starts disconnected): ${errMsg(e)}`);
      client = await foundation();
    }
  }

  const h0 = client.health();
  warnOnAdtLsVersionMismatch(h0.adtLsVersion, (m) => logger.warn(`engine: ${m}`));
  const connectedDestination = h0.connected ? h0.destination : undefined;
  if (connectedDestination) logger.info(`engine: connected destination ${connectedDestination}`);

  return {
    connectedDestination,
    lifecycle: wrapLifecycle(client, safety),
    navigation: client.navigation,
    quality: client.quality,
    services: wrapServices(client, safety),
    health: () => {
      const h = client.health();
      return {
        adtLs: { name: h.adtLsName, version: h.adtLsVersion, up: true },
        mcpPort: h.mcpPort,
        connectedDestination: h.connected ? h.destination : undefined,
        backendLive: h.backendLive,
      };
    },
    callTool: (name, args = {}) => client.raw.tool(name, args),
    search: async (pattern, opts = {}) => {
      const r = await client.repository.search(pattern, { maxResults: opts.maxResults, types: opts.types, cold: true });
      return r.references ?? [];
    },
    listInactiveObjects: () => client.repository.listInactive() as Promise<unknown[]>,
    listUsers: () => client.repository.getUsers(),
    reconnect: () => client.reconnect(),
    dispose: async () => {
      await client.dispose().catch(() => {});
      await bridge?.close().catch(() => {});
    },
  };
}

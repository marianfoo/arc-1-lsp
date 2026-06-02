/**
 * The arc-1-lsp engine: discovers a developer-provided adt-ls, spawns it
 * headless, starts adt-ls's own MCP server over LSP, and connects a federation
 * client to it. All ABAP/ADT work happens inside adt-ls — arc-1-lsp orchestrates.
 *
 * When a SAP target is configured, the engine also performs the headless
 * connection (ADR-0005/0006): build TLS material from adt-ls's own JRE, start a
 * TLS-terminating reverse proxy, spawn adt-ls trusting it, then create the
 * destination + reentrance-logon + bind it to adt-ls's MCP server. Two paths:
 *   - DIRECT (local, ARC1_SAP_*): reverse proxy connects straight to the backend.
 *   - CONNECTIVITY (CF, ARC1_SAP_DESTINATION + bound connectivity): resolve the
 *     BTP destination, start the connectivity bridge, and forward the reverse
 *     proxy's upstream through it → Cloud Connector → backend.
 */
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAdtLsTls } from '../adt-ls/cert.js';
import {
  type LogonCredentials,
  REQUEST_BROWSER_LOGON,
  createDestination,
  ensureLoggedOn,
  initializeDestinationsService,
  makeReentranceLogonHandler,
} from '../adt-ls/destinations.js';
import { resolveAdtLsPath } from '../adt-ls/discovery.js';
import { AdtLsDriver, type LspClient, type LspRequester } from '../adt-ls/driver.js';
import { type Lifecycle, createLifecycle } from '../adt-ls/lifecycle.js';
import { AdtLsMcpClient, type McpTool } from '../adt-ls/mcp-federation.js';
import {
  type StartMcpServerResult,
  setMcpDestination,
  startMcpServer,
  stopMcpServer,
} from '../adt-ls/mcp-lifecycle.js';
import { type Navigation, createNavigation } from '../adt-ls/navigation.js';
import { type Quality, createQuality } from '../adt-ls/quality.js';
import { type SearchReference, type UserRef, getInactiveObjects, getUsers, quickSearch } from '../adt-ls/repository.js';
import { type Services, createServices } from '../adt-ls/services.js';
import { isLoggedOffFederatedResult, makeRelogon, makeWithRelogon } from '../adt-ls/session-retry.js';
import { type TlsReverseProxy, startTlsReverseProxy } from '../adt-ls/tls-reverse-proxy.js';
import { type ConnectivityBridge, startConnectivityBridge } from '../btp/bridge.js';
import { createConnectivityProxy } from '../btp/connectivity.js';
import { lookupDestination } from '../btp/destination.js';
import type { BTPConfig } from '../btp/types.js';
import { parseVCAPServices } from '../btp/vcap.js';
import { warnOnAdtLsVersionMismatch } from '../version.js';
import type { Arc1LspConfig, SapTargetConfig } from './config.js';
import { logger } from './logger.js';

export interface EngineHealth {
  adtLs: { name?: string; version?: string; up: boolean };
  mcpPort: number;
  connectedDestination?: string;
}

export interface Engine {
  health(): EngineHealth;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  setDestination(destinationId: string): Promise<void>;
  /** Repository object search (LSP quickSearch) on the connected destination. */
  search(pattern: string, opts?: { maxResults?: number; types?: string[] }): Promise<SearchReference[]>;
  /** Inactive (draft) objects on the connected destination (LSP). */
  listInactiveObjects(): Promise<unknown[]>;
  /** System users on the connected destination (LSP). */
  listUsers(): Promise<UserRef[]>;
  /** ABAP object authoring lifecycle (read/create/update/activate/test/delete). */
  lifecycle: Lifecycle;
  /** Raw LSP client (request + notification) for code-intelligence (didOpen → query → didClose). */
  lsp: LspClient;
  /** LSP code-intelligence: document symbols, definition, references, type hierarchy, syntax check, completion. */
  navigation: Navigation;
  /** Quality & test: ATC static analysis, ABAP Unit code coverage. */
  quality: Quality;
  /** Runtime & business services: run application (console), service-binding details/publish. */
  services: Services;
  /** The destination logged on at startup, if any. */
  connectedDestination?: string;
  /**
   * Force a SAP re-logon on the connected destination; resolves true when the
   * session is live afterwards. Invoked automatically on a detected "logged off"
   * (see the session-retry wrappers), and exposed for ops / manual recovery.
   */
  reconnect(): Promise<boolean>;
  dispose(): Promise<void>;
}

/** Minimal info needed to create + logon a destination (mode-agnostic). */
export interface BackendDescriptor {
  destinationId: string;
  user?: string;
  client: string;
  language: string;
}

export type ConnectionPlan =
  | { mode: 'none' }
  | { mode: 'direct'; target: SapTargetConfig }
  | { mode: 'connectivity'; destinationName: string };

/**
 * Decide how to connect (pure). On BTP (connectivity bound) a destination name
 * wins → Cloud-Connector path. Otherwise a full local target → direct. Else none.
 */
export function planConnection(config: Arc1LspConfig, btp: BTPConfig | null): ConnectionPlan {
  const onBtp = !!btp?.connectivityProxyHost;
  if (onBtp && config.sapDestination) return { mode: 'connectivity', destinationName: config.sapDestination };
  if (config.sapTarget) return { mode: 'direct', target: config.sapTarget };
  return { mode: 'none' };
}

/**
 * Start adt-ls's MCP server, falling back to the next port when the requested one is
 * already bound — concurrent arc-1-lsp instances, a leftover bind, or parallel live
 * tests all contend for the default port. Tries `attempts` consecutive ports; only a
 * bind-failure is retried (any other error rethrows immediately). Injectable `start`
 * (port → result) keeps it unit-testable. Returns the EFFECTIVE port adt-ls bound.
 */
export async function startMcpWithPortFallback(
  start: (port: number) => Promise<StartMcpServerResult>,
  startPort: number,
  attempts = 20,
  onRetry: (busyPort: number) => void = () => {},
): Promise<StartMcpServerResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = startPort + i;
    try {
      return await start(port);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/failed to bind|address already in use|eaddrinuse/i.test(msg)) throw e;
      onRetry(port);
    }
  }
  throw lastErr;
}

export async function startEngine(config: Arc1LspConfig): Promise<Engine> {
  const bin = resolveAdtLsPath({ explicitPath: config.adtLsPath });
  logger.info(`engine: using adt-ls at ${bin}`);

  const btp = parseVCAPServices();
  const plan = planConnection(config, btp);

  // TLS material must exist before adt-ls spawns (JAVA_TOOL_OPTIONS truststore).
  let tlsWorkDir: string | undefined;
  let proxyKeyPem: string | undefined;
  let proxyCertPem: string | undefined;
  const driverOpts: ConstructorParameters<typeof AdtLsDriver>[1] = {};
  if (plan.mode !== 'none') {
    tlsWorkDir = path.join(os.tmpdir(), `arc1lsp-tls-${crypto.randomBytes(6).toString('hex')}`);
    const tls = await prepareAdtLsTls({ adtLsBin: bin, workDir: tlsWorkDir });
    proxyKeyPem = tls.proxyKeyPem;
    proxyCertPem = tls.proxyCertPem;
    driverOpts.extraEnv = { JAVA_TOOL_OPTIONS: tls.javaToolOptions };
  }

  const driver = new AdtLsDriver(bin, driverOpts);
  const init = await driver.start();
  warnOnAdtLsVersionMismatch(init.serverInfo?.version, (m) => logger.warn(`engine: ${m}`));

  const token = config.adtLsMcpToken || crypto.randomBytes(24).toString('hex');
  const started = await startMcpWithPortFallback(
    (port) => startMcpServer(driver, { port, token }),
    config.adtLsMcpPort,
    20,
    (busyPort) => logger.warn(`engine: adt-ls MCP port ${busyPort} busy — trying ${busyPort + 1}`),
  );
  logger.info(`engine: adt-ls MCP server on http://localhost:${started.port}/mcp`);

  const federation = new AdtLsMcpClient(`http://localhost:${started.port}/mcp`, started.token);
  await federation.connect();

  let proxy: TlsReverseProxy | undefined;
  let bridge: ConnectivityBridge | undefined;
  let connectedDestination: string | undefined;

  if (plan.mode !== 'none') {
    // Non-fatal: a logon/connectivity failure must NOT crash the MCP server —
    // health/tools still come up (reporting disconnected) so it's diagnosable.
    try {
      const conn = await connect(plan, btp, driver, {
        keyPem: proxyKeyPem as string,
        certPem: proxyCertPem as string,
        tlsWorkDir: tlsWorkDir as string,
      });
      proxy = conn.proxy;
      bridge = conn.bridge;
      connectedDestination = conn.destinationId;
    } catch (e) {
      logger.error(
        `engine: SAP connection failed (server starts disconnected): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Self-healing SAP session: the backend security session behind adt-ls expires
  // on inactivity; afterwards every call fails with "logged off" until a reconnect
  // (previously: restart the instance). On detecting that, re-fire the proven
  // startup logon (ensureLoggedOn re-triggers our still-registered reentrance
  // handler) and retry the call once. Wrap BOTH channels — federated MCP tool
  // calls and raw LSP requests — since either can hit the dead session.
  const relogon = makeRelogon(async () => {
    if (!connectedDestination) return false;
    logger.warn(`engine: SAP session lost — re-logging on to ${connectedDestination}`);
    try {
      const logon = await ensureLoggedOn(driver, connectedDestination);
      if (logon.logonState !== 'connected') {
        logger.error(`engine: re-logon to ${connectedDestination} returned ${logon.logonState}`);
        return false;
      }
      // Re-point adt-ls's MCP server at the refreshed session (idempotent, best-effort).
      await setMcpDestination(driver, connectedDestination).catch((e) =>
        logger.warn(`engine: re-bind after re-logon failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      logger.info(`engine: re-logon to ${connectedDestination} succeeded`);
      return true;
    } catch (e) {
      logger.error(`engine: re-logon failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  });
  const withRelogon = makeWithRelogon(relogon);
  const sessionCallTool = (name: string, args: Record<string, unknown> = {}) =>
    withRelogon(() => federation.callTool(name, args), isLoggedOffFederatedResult);
  const sessionRequester: LspRequester = {
    sendRequest: <T>(method: string, params?: unknown) => withRelogon<T>(() => driver.sendRequest<T>(method, params)),
  };
  // Code-intelligence LSP client: relogon-wrapped requests + raw notifications
  // (didOpen/didClose are fire-and-forget, no response to retry).
  const lsp: LspClient = {
    sendRequest: <T>(method: string, params?: unknown) => withRelogon<T>(() => driver.sendRequest<T>(method, params)),
    sendNotification: (method: string, params?: unknown) => driver.sendNotification(method, params),
  };

  const safety = {
    allowWrites: config.allowWrites,
    allowTransportWrites: config.allowTransportWrites,
    allowedPackages: config.allowedPackages,
  };
  const lifecycle = createLifecycle({
    driver: sessionRequester,
    callTool: sessionCallTool,
    destination: () => connectedDestination,
    safety,
  });
  const navigation = createNavigation({ lsp, lifecycle });
  const quality = createQuality({ lsp, lifecycle });
  const services = createServices({ lsp, lifecycle, safety });

  const engine: Engine = {
    connectedDestination,
    lifecycle,
    lsp,
    navigation,
    quality,
    services,
    health: () => ({
      adtLs: { name: init.serverInfo?.name, version: init.serverInfo?.version, up: true },
      mcpPort: started.port,
      connectedDestination,
    }),
    listTools: () => federation.listTools(),
    callTool: (name, args = {}) => sessionCallTool(name, args),
    setDestination: async (destinationId) => {
      await setMcpDestination(driver, destinationId);
    },
    search: async (pattern, opts = {}) => {
      if (!connectedDestination) throw new Error('No ABAP destination is connected.');
      const r = await quickSearch(
        sessionRequester,
        { destination: connectedDestination, pattern, maxResults: opts.maxResults, types: opts.types },
        { retryOnEmptyMs: 600 }, // cold-cache smoothing on the first search after connect
      );
      return r.references ?? [];
    },
    listInactiveObjects: async () => {
      if (!connectedDestination) throw new Error('No ABAP destination is connected.');
      return getInactiveObjects(sessionRequester, connectedDestination);
    },
    listUsers: async () => {
      if (!connectedDestination) throw new Error('No ABAP destination is connected.');
      return getUsers(sessionRequester, connectedDestination);
    },
    reconnect: () => relogon(),
    dispose: async () => {
      await stopMcpServer(driver).catch(() => {});
      await driver.dispose();
      await proxy?.close().catch(() => {});
      await bridge?.close().catch(() => {});
      if (tlsWorkDir) await fsp.rm(tlsWorkDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return engine;
}

/** Resolve the backend, start the proxy (+bridge on CF), register the logon handler, connect. */
async function connect(
  plan: Exclude<ConnectionPlan, { mode: 'none' }>,
  btp: BTPConfig | null,
  driver: AdtLsDriver,
  tls: { keyPem: string; certPem: string; tlsWorkDir: string },
): Promise<{ proxy: TlsReverseProxy; bridge?: ConnectivityBridge; destinationId: string }> {
  let backend: BackendDescriptor;
  let creds: LogonCredentials;
  let proxy: TlsReverseProxy;
  let bridge: ConnectivityBridge | undefined;

  if (plan.mode === 'connectivity') {
    const dest = await lookupDestination(btp as BTPConfig, plan.destinationName);
    const url = new URL(dest.URL);
    const scheme = url.protocol === 'https:' ? 'https' : 'http';
    const port = Number(url.port || (scheme === 'https' ? 443 : 80));
    creds = { kind: 'basic', user: dest.User ?? '', password: dest.Password ?? '' };
    backend = {
      destinationId: plan.destinationName,
      user: dest.User,
      client: dest['sap-client'] ?? '001',
      language: 'EN',
    };
    const proxyCfg = createConnectivityProxy(btp as BTPConfig, dest.CloudConnectorLocationId);
    if (!proxyCfg) throw new Error('connectivity service binding missing onpremise_proxy_host');
    bridge = await startConnectivityBridge(proxyCfg);
    proxy = await startTlsReverseProxy({
      key: tls.keyPem,
      cert: tls.certPem,
      target: { host: url.hostname, port, protocol: scheme },
      forwardProxy: { host: '127.0.0.1', port: bridge.port },
    });
  } else {
    const t = plan.target;
    creds = { kind: 'basic', user: t.user, password: t.password };
    backend = { destinationId: t.destinationId, user: t.user, client: t.client, language: t.language };
    proxy = await startTlsReverseProxy({
      key: tls.keyPem,
      cert: tls.certPem,
      target: { host: t.host, port: t.port },
      insecureUpstream: t.insecure,
    });
  }

  // Register the reentrance handler (our own GET to the localhost proxy skips TLS).
  driver.setRequestHandler(REQUEST_BROWSER_LOGON, makeReentranceLogonHandler(creds, { insecure: true }));
  const destinationId = await connectDestination(driver, backend, proxy, tls.tlsWorkDir);
  return { proxy, bridge, destinationId };
}

/** Create + reentrance-logon + bind the destination. Returns its id, or throws. */
export async function connectDestination(
  driver: AdtLsDriver,
  backend: BackendDescriptor,
  proxy: TlsReverseProxy,
  tlsWorkDir: string,
): Promise<string> {
  // Isolated store — NEVER the global ~/.adtls/destinations.json (shared with IDEs).
  const storePath = path.join(tlsWorkDir, 'destinations');
  await fsp.mkdir(storePath, { recursive: true });
  await initializeDestinationsService(driver, storePath);

  await createDestination(driver, {
    id: backend.destinationId,
    systemUrl: proxy.url,
    user: backend.user,
    client: backend.client,
    language: backend.language,
  });

  const logon = await ensureLoggedOn(driver, backend.destinationId);
  if (logon.logonState !== 'connected') {
    throw new Error(
      `adt-ls logon to ${backend.destinationId} failed: ${logon.logonState}${logon.message ? ` — ${logon.message}` : ''}`,
    );
  }
  await setMcpDestination(driver, backend.destinationId);
  logger.info(`engine: connected destination ${backend.destinationId}`);
  return backend.destinationId;
}

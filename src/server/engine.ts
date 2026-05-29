/**
 * The arc-1-lsp engine: discovers a developer-provided adt-ls, spawns it
 * headless, starts adt-ls's own MCP server over LSP, and connects a federation
 * client to it. All ABAP/ADT work happens inside adt-ls — arc-1-lsp orchestrates.
 *
 * When a SAP target is configured, the engine also performs the headless
 * connection (ADR-0005/0006): build TLS material from adt-ls's own JRE, start a
 * TLS-terminating reverse proxy, spawn adt-ls trusting it, then create the
 * destination + reentrance-logon + bind it to adt-ls's MCP server.
 */
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAdtLsTls } from '../adt-ls/cert.js';
import {
  REQUEST_BROWSER_LOGON,
  createDestination,
  ensureLoggedOn,
  initializeDestinationsService,
  makeReentranceLogonHandler,
} from '../adt-ls/destinations.js';
import { resolveAdtLsPath } from '../adt-ls/discovery.js';
import { AdtLsDriver } from '../adt-ls/driver.js';
import { AdtLsMcpClient, type McpTool } from '../adt-ls/mcp-federation.js';
import { setMcpDestination, startMcpServer, stopMcpServer } from '../adt-ls/mcp-lifecycle.js';
import { type TlsReverseProxy, startTlsReverseProxy } from '../adt-ls/tls-reverse-proxy.js';
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
  /** The destination logged on at startup, if any. */
  connectedDestination?: string;
  dispose(): Promise<void>;
}

export async function startEngine(config: Arc1LspConfig): Promise<Engine> {
  const bin = resolveAdtLsPath({ explicitPath: config.adtLsPath });
  logger.info(`engine: using adt-ls at ${bin}`);

  const target = config.sapTarget;
  // TLS material + reverse proxy + logon handler, only when a SAP target is set.
  let tlsWorkDir: string | undefined;
  let proxy: TlsReverseProxy | undefined;
  const driverOpts: ConstructorParameters<typeof AdtLsDriver>[1] = {};

  if (target) {
    tlsWorkDir = path.join(os.tmpdir(), `arc1lsp-tls-${crypto.randomBytes(6).toString('hex')}`);
    const tls = await prepareAdtLsTls({ adtLsBin: bin, workDir: tlsWorkDir });
    proxy = await startTlsReverseProxy({
      key: tls.proxyKeyPem,
      cert: tls.proxyCertPem,
      target: { host: target.host, port: target.port },
      insecureUpstream: target.insecure,
    });
    driverOpts.extraEnv = { JAVA_TOOL_OPTIONS: tls.javaToolOptions };
    driverOpts.requestHandlers = {
      [REQUEST_BROWSER_LOGON]: makeReentranceLogonHandler(
        { kind: 'basic', user: target.user, password: target.password },
        { insecure: target.insecure },
      ),
    };
  }

  const driver = new AdtLsDriver(bin, driverOpts);
  const init = await driver.start();

  const token = config.adtLsMcpToken || crypto.randomBytes(24).toString('hex');
  const started = await startMcpServer(driver, { port: config.adtLsMcpPort, token });
  logger.info(`engine: adt-ls MCP server on http://localhost:${started.port}/mcp`);

  const federation = new AdtLsMcpClient(`http://localhost:${started.port}/mcp`, started.token);
  await federation.connect();

  let connectedDestination: string | undefined;
  if (target && proxy) {
    connectedDestination = await connectDestination(driver, target, proxy, tlsWorkDir as string);
  }

  const engine: Engine = {
    connectedDestination,
    health: () => ({
      adtLs: { name: init.serverInfo?.name, version: init.serverInfo?.version, up: true },
      mcpPort: started.port,
      connectedDestination,
    }),
    listTools: () => federation.listTools(),
    callTool: (name, args = {}) => federation.callTool(name, args),
    setDestination: async (destinationId) => {
      await setMcpDestination(driver, destinationId);
    },
    dispose: async () => {
      await stopMcpServer(driver).catch(() => {});
      await driver.dispose();
      await proxy?.close().catch(() => {});
      if (tlsWorkDir) await fsp.rm(tlsWorkDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return engine;
}

/** Create + reentrance-logon + bind the destination. Returns its id, or throws. */
export async function connectDestination(
  driver: AdtLsDriver,
  target: SapTargetConfig,
  proxy: TlsReverseProxy,
  tlsWorkDir: string,
): Promise<string> {
  // Isolated store — NEVER the global ~/.adtls/destinations.json (shared with IDEs).
  const storePath = path.join(tlsWorkDir, 'destinations');
  await fsp.mkdir(storePath, { recursive: true });
  await initializeDestinationsService(driver, storePath);

  await createDestination(driver, {
    id: target.destinationId,
    systemUrl: proxy.url,
    user: target.user,
    client: target.client,
    language: target.language,
  });

  const logon = await ensureLoggedOn(driver, target.destinationId);
  if (logon.logonState !== 'connected') {
    throw new Error(
      `adt-ls logon to ${target.destinationId} failed: ${logon.logonState}${logon.message ? ` — ${logon.message}` : ''}`,
    );
  }
  await setMcpDestination(driver, target.destinationId);
  logger.info(`engine: connected destination ${target.destinationId} (${target.host}:${target.port})`);
  return target.destinationId;
}

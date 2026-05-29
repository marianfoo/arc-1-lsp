/**
 * The arc-1-lsp engine: discovers a developer-provided adt-ls, spawns it
 * headless, starts adt-ls's own MCP server over LSP, and connects a federation
 * client to it. All ABAP/ADT work happens inside adt-ls — arc-1-lsp orchestrates.
 */
import crypto from 'node:crypto';
import { resolveAdtLsPath } from '../adt-ls/discovery.js';
import { AdtLsDriver } from '../adt-ls/driver.js';
import { AdtLsMcpClient, type McpTool } from '../adt-ls/mcp-federation.js';
import { setMcpDestination, startMcpServer, stopMcpServer } from '../adt-ls/mcp-lifecycle.js';
import type { Arc1LspConfig } from './config.js';
import { logger } from './logger.js';

export interface EngineHealth {
  adtLs: { name?: string; version?: string; up: boolean };
  mcpPort: number;
}

export interface Engine {
  health(): EngineHealth;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  setDestination(destinationId: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function startEngine(config: Arc1LspConfig): Promise<Engine> {
  const bin = resolveAdtLsPath({ explicitPath: config.adtLsPath });
  logger.info(`engine: using adt-ls at ${bin}`);
  const driver = new AdtLsDriver(bin);
  const init = await driver.start();

  const token = config.adtLsMcpToken || crypto.randomBytes(24).toString('hex');
  const started = await startMcpServer(driver, { port: config.adtLsMcpPort, token });
  logger.info(`engine: adt-ls MCP server on http://localhost:${started.port}/mcp`);

  const federation = new AdtLsMcpClient(`http://localhost:${started.port}/mcp`, started.token);
  await federation.connect();

  return {
    health: () => ({
      adtLs: { name: init.serverInfo?.name, version: init.serverInfo?.version, up: true },
      mcpPort: started.port,
    }),
    listTools: () => federation.listTools(),
    callTool: (name, args = {}) => federation.callTool(name, args),
    setDestination: async (destinationId) => {
      await setMcpDestination(driver, destinationId);
    },
    dispose: async () => {
      await stopMcpServer(driver).catch(() => {});
      await driver.dispose();
    },
  };
}

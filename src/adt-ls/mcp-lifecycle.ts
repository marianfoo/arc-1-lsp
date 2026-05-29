/**
 * Thin wrappers over adt-ls's custom MCP-lifecycle LSP requests. These let
 * arc-1-lsp boot/stop adt-ls's own Streamable-HTTP MCP server and bind it to a
 * destination — without VS Code. Verified live: startMCPServer accepts a
 * caller-supplied port+token and returns the effective values.
 */
import type { AdtLsDriver } from './driver.js';

export interface StartMcpServerResult {
  port: number;
  token: string;
}

export function startMcpServer(
  driver: AdtLsDriver,
  opts: { port: number; token: string },
): Promise<StartMcpServerResult> {
  return driver.sendRequest<StartMcpServerResult>('adtLs/mcp/startMCPServer', opts);
}

export function stopMcpServer(driver: AdtLsDriver): Promise<unknown> {
  return driver.sendRequest('adtLs/mcp/stopMCPServer');
}

export function setMcpDestination(driver: AdtLsDriver, destinationId: string): Promise<unknown> {
  return driver.sendRequest('adtLs/mcp/setDestination', { destinationId });
}

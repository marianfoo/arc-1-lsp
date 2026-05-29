/**
 * The arc-1-lsp MCP server (the "shell"). Reuses the ARC-1 shape — a small set
 * of intent tools — but every tool is backed by the embedded adt-ls engine, not
 * a hand-rolled ADT client. Foundation exposes two tools: `health` and
 * `list_destinations`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Engine } from './engine.js';

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'arc-1-lsp', version: '0.0.1' });

  server.registerTool(
    'health',
    {
      description:
        'Report arc-1-lsp and embedded adt-ls health (adt-ls version, MCP port, up state). No SAP connection required.',
      inputSchema: {},
    },
    async () => text(engine.health()),
  );

  server.registerTool(
    'list_destinations',
    {
      description: 'List the available ABAP system destinations, federated from the embedded adt-ls.',
      inputSchema: {},
    },
    async () => text(await engine.callTool('abap_list_destinations', {})),
  );

  return server;
}

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Arc1LspConfig } from '../../../src/server/config.js';
import { startHttpServer } from '../../../src/server/http.js';

function makeServer(): McpServer {
  const s = new McpServer({ name: 'test', version: '0.0.1' });
  s.registerTool('health', { description: 'health', inputSchema: {} }, async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
  }));
  return s;
}

const config: Arc1LspConfig = {
  adtLsMcpPort: 2240,
  transport: 'http-streamable',
  httpPort: 0, // OS-assigned free port
  apiKeys: 'secret:dev',
};

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

describe('startHttpServer', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = startHttpServer(makeServer, config);
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /healthz returns 200 ok without auth', async () => {
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('POST /mcp without an API key returns 401', async () => {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: initBody,
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp initialize with a valid key reaches the transport (200)', async () => {
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/serverInfo|result|protocolVersion/);
  });

  it('unknown path returns 404', async () => {
    const res = await fetch(`http://localhost:${port}/nope`);
    expect(res.status).toBe(404);
  });
});

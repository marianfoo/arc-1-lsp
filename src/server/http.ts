/**
 * http-streamable transport for arc-1-lsp (required for BTP CF). Mounts the MCP
 * SDK StreamableHTTPServerTransport at POST /mcp behind an API-key check, plus
 * an unauthenticated GET /healthz for CF health checks. Stateless per-request
 * (a fresh server+transport per call) — simple and adequate for the foundation
 * deploy; session-stateful mode can come later.
 */
import { type Server, createServer } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkApiKey, parseApiKeys } from './auth.js';
import type { Arc1LspConfig } from './config.js';
import { logger } from './logger.js';

export function startHttpServer(makeServer: () => McpServer, config: Arc1LspConfig): Server {
  const keys = parseApiKeys(config.apiKeys);
  if (keys.length === 0) {
    logger.warn('ARC1_API_KEYS not set — /mcp is UNAUTHENTICATED (acceptable for local dev only).');
  }

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      if (!req.url || !req.url.startsWith('/mcp')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (!checkApiKey({ authorization: req.headers.authorization, 'x-api-key': req.headers['x-api-key'] }, keys)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      logger.error(`http handler error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
      }
    }
  });

  httpServer.listen(config.httpPort, '0.0.0.0', () => {
    logger.info(`arc-1-lsp MCP server ready (http-streamable) on :${config.httpPort}/mcp`);
  });
  return httpServer;
}

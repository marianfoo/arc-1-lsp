/**
 * Connectivity bridge: a local HTTP forward proxy that adt-ls routes through.
 * adt-ls sends absolute-form proxy requests (`GET http://target/path`); the
 * bridge re-emits them to the BTP connectivity proxy using **standard HTTP-proxy
 * protocol** (NOT CONNECT — the connectivity proxy 405s on CONNECT), adding
 * `Proxy-Authorization: Bearer <connectivity token>` and the Cloud-Connector
 * `SAP-Connectivity-SCC-Location_ID` header. Mirrors arc-1's `doProxyRequest`.
 *
 * Backend auth (e.g. basic `DEVELOPER`) is adt-ls's concern and flows through
 * untouched — the bridge only owns the connectivity-proxy hop.
 */
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from '../server/logger.js';
import type { BTPProxyConfig } from './types.js';

export interface ConnectivityBridge {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function startConnectivityBridge(proxy: BTPProxyConfig): Promise<ConnectivityBridge> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, proxy);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  logger.info(`connectivity bridge on 127.0.0.1:${port} → ${proxy.host}:${proxy.port}`);
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, proxy: BTPProxyConfig): Promise<void> {
  const target = req.url ?? '';
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('expected absolute-form proxy request');
    return;
  }
  try {
    const token = await proxy.getProxyToken();
    const targetUrl = new URL(target);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    headers.Host = targetUrl.port ? `${targetUrl.hostname}:${targetUrl.port}` : targetUrl.hostname;
    headers['Proxy-Authorization'] = `Bearer ${token}`;
    if (proxy.locationId) headers['SAP-Connectivity-SCC-Location_ID'] = proxy.locationId;

    // Standard HTTP proxy: send the FULL target URL as the request path.
    const proxyReq = httpRequest(
      { host: proxy.host, port: proxy.port, method: req.method, path: target, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (e) => {
      logger.error(`bridge upstream error: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('bridge upstream error');
    });
    req.pipe(proxyReq);
  } catch (e) {
    logger.error(`bridge error: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('bridge error');
  }
}

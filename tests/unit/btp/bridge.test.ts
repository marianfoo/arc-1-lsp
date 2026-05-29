import { type Server, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnectivityBridge, startConnectivityBridge } from '../../../src/btp/bridge.js';
import type { BTPProxyConfig } from '../../../src/btp/types.js';

describe('startConnectivityBridge', () => {
  let mockProxy: Server | undefined;
  let bridge: ConnectivityBridge | undefined;
  afterEach(async () => {
    await bridge?.close();
    await new Promise<void>((r) => (mockProxy ? mockProxy.close(() => r()) : r()));
  });

  it('forwards the absolute URL with Proxy-Authorization + SCC location and relays the response', async () => {
    let captured: { method?: string; url?: string; headers: Record<string, unknown> } = { headers: {} };
    mockProxy = createServer((req, res) => {
      captured = { method: req.method, url: req.url, headers: req.headers };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello-from-backend');
    });
    const proxyPort = await new Promise<number>((r) =>
      mockProxy?.listen(0, '127.0.0.1', () => r((mockProxy?.address() as AddressInfo).port)),
    );

    const proxyCfg: BTPProxyConfig = {
      host: '127.0.0.1',
      port: proxyPort,
      protocol: 'http',
      locationId: 'LOC1',
      getProxyToken: async () => 'ptok',
    };
    bridge = await startConnectivityBridge(proxyCfg);

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request(
        {
          host: '127.0.0.1',
          port: bridge?.port,
          method: 'GET',
          path: 'http://a4h-virtual:50000/sap/bc/adt/x', // absolute-form proxy request
          headers: { 'x-custom': '1' },
        },
        (resp) => {
          const chunks: Buffer[] = [];
          resp.on('data', (c) => chunks.push(c as Buffer));
          resp.on('end', () => resolve({ status: resp.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        },
      );
      r.on('error', reject);
      r.end();
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('hello-from-backend');
    expect(captured.url).toBe('http://a4h-virtual:50000/sap/bc/adt/x'); // absolute path preserved (standard HTTP proxy)
    expect(captured.headers['proxy-authorization']).toBe('Bearer ptok');
    expect(captured.headers['sap-connectivity-scc-location_id']).toBe('LOC1');
    expect(captured.headers['x-custom']).toBe('1'); // client header passed through
    expect(captured.headers.host).toBe('a4h-virtual:50000');
  });
});

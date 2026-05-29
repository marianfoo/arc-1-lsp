import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateLocalhostCert } from '../../../src/adt-ls/cert.js';
import { type TlsReverseProxy, startTlsReverseProxy } from '../../../src/adt-ls/tls-reverse-proxy.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function httpsGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const enabled = hasOpenssl();

describe.skipIf(!enabled)('startTlsReverseProxy (needs openssl)', () => {
  let dir: string;
  let key: string;
  let cert: string;
  let upstream: https.Server;
  let upstreamPort: number;
  let proxy: TlsReverseProxy | undefined;
  const upstreamHits: Array<{ url?: string; auth?: string; host?: string }> = [];

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arc1-proxy-test-'));
    const c = await generateLocalhostCert(dir);
    key = c.keyPem;
    cert = c.certPem;
    upstream = https.createServer({ key, cert }, (req, res) => {
      upstreamHits.push({ url: req.url, auth: req.headers.authorization, host: req.headers.host });
      if (req.url === '/redirect') {
        res.writeHead(307, { location: 'http://localhost:9/adt/redirect?reentrance-ticket=T' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`upstream saw ${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await proxy?.close();
    upstream?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('forwards requests to the upstream and relays the response', async () => {
    proxy = await startTlsReverseProxy({ key, cert, target: { host: '127.0.0.1', port: upstreamPort } });
    expect(proxy.url).toMatch(/^https:\/\/localhost:\d+$/);

    const res = await httpsGet(`${proxy.url}/sap/bc/adt/discovery`, { authorization: 'Basic xyz' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('upstream saw GET /sap/bc/adt/discovery');

    const lastHit = upstreamHits.at(-1);
    expect(lastHit?.url).toBe('/sap/bc/adt/discovery');
    expect(lastHit?.auth).toBe('Basic xyz'); // headers forwarded as-is
  });

  it('relays redirects (307 + Location) unchanged — needed for the reentrance flow', async () => {
    if (!proxy) proxy = await startTlsReverseProxy({ key, cert, target: { host: '127.0.0.1', port: upstreamPort } });
    const res = await httpsGet(`${proxy.url}/redirect`);
    expect(res.status).toBe(307);
    expect(res.location).toContain('reentrance-ticket=T');
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const p = await startTlsReverseProxy({ key, cert, target: { host: '127.0.0.1', port: 1 } });
    try {
      const res = await httpsGet(`${p.url}/x`);
      expect(res.status).toBe(502);
    } finally {
      await p.close();
    }
  });
});

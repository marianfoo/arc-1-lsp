/**
 * TLS-terminating reverse proxy (ADR-0005 / ADR-0006).
 *
 * adt-ls requires an HTTPS `systemUrl` and validates the backend cert's hostname.
 * SAP on-prem systems (e.g. a4h) present the default self-signed cert
 * `CN=*.dummy.nodomain`, which fails hostname verification — and adt-ls's Apache
 * HTTP client ignores `-Djdk.internal.httpclient.disableHostnameVerification`.
 *
 * The fix: point adt-ls's destination at `https://localhost:<port>` served by this
 * proxy with a `CN=localhost` cert (added to the JVM truststore → trust ✓ +
 * hostname ✓). The proxy re-originates each request to the real SAP host, where WE
 * (Node) own the TLS and can accept the self-signed cert (`insecureUpstream`).
 *
 * Two upstream modes:
 *   - DIRECT (local): connect straight to the backend over HTTPS (a4h:50001).
 *   - FORWARD-PROXY (CF): re-emit each request as a standard absolute-form HTTP
 *     proxy request to `forwardProxy` (the connectivity bridge), which adds the
 *     connectivity token + Cloud-Connector header → CC → backend. Same TLS
 *     termination for adt-ls; only the backend hop differs.
 *
 * Request headers are forwarded as-is so SAP builds the reentrance `logonUrl`
 * against `localhost:<port>` (which our logon handler then GETs back through here).
 */
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { logger } from '../server/logger.js';

export interface TlsReverseProxyOptions {
  /** PEM-encoded server key + cert for the local HTTPS listener (CN=localhost). */
  key: string | Buffer;
  cert: string | Buffer;
  /** Real backend to forward to. `protocol` only matters in forward-proxy mode. */
  target: { host: string; port: number; protocol?: 'http' | 'https' };
  /** DIRECT mode: accept the backend's (self-signed) cert. Default true. */
  insecureUpstream?: boolean;
  /** Bind host for the local listener. Default 127.0.0.1. */
  bindHost?: string;
  /**
   * When set, forward via this HTTP proxy (the connectivity bridge) instead of
   * connecting directly — the CF / Cloud-Connector path.
   */
  forwardProxy?: { host: string; port: number };
}

export interface TlsReverseProxy {
  /** Bound port of the local HTTPS listener. */
  port: number;
  /** `https://localhost:<port>` — use as the adt-ls destination systemUrl. */
  url: string;
  close(): Promise<void>;
}

export async function startTlsReverseProxy(opts: TlsReverseProxyOptions): Promise<TlsReverseProxy> {
  const insecureUpstream = opts.insecureUpstream ?? true;
  const bindHost = opts.bindHost ?? '127.0.0.1';

  const fwd = opts.forwardProxy;
  const scheme = opts.target.protocol ?? (fwd ? 'http' : 'https');

  const server = https.createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    const onUpstream = (upRes: http.IncomingMessage) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    };
    const upstream = fwd
      ? // FORWARD-PROXY mode: absolute-form request to the connectivity bridge.
        http.request(
          {
            host: fwd.host,
            port: fwd.port,
            method: req.method,
            path: `${scheme}://${opts.target.host}:${opts.target.port}${req.url}`,
            headers: { ...req.headers, host: `${opts.target.host}:${opts.target.port}` },
          },
          onUpstream,
        )
      : // DIRECT mode: straight to the backend over HTTPS.
        https.request(
          {
            host: opts.target.host,
            port: opts.target.port,
            method: req.method,
            path: req.url,
            headers: req.headers,
            rejectUnauthorized: !insecureUpstream,
          },
          onUpstream,
        );
    upstream.on('error', (err) => {
      logger.warn(`tls-reverse-proxy: upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`reverse-proxy upstream error: ${err.message}`);
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  // CN=localhost cert ⇒ advertise the host as `localhost`, not the bind IP.
  const url = `https://localhost:${port}`;
  const via = fwd ? ` via connectivity bridge ${fwd.host}:${fwd.port}` : '';
  logger.info(`tls-reverse-proxy: ${url} → ${scheme}://${opts.target.host}:${opts.target.port}${via}`);

  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

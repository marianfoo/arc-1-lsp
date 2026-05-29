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
 * This is the SAME shape the CF deployment needs: there the upstream side instead
 * forwards through the BTP connectivity bridge → Cloud Connector → backend.
 *
 * Request headers are forwarded as-is so SAP builds the reentrance `logonUrl`
 * against `localhost:<port>` (which our logon handler then GETs back through here).
 */
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { logger } from '../server/logger.js';

export interface TlsReverseProxyOptions {
  /** PEM-encoded server key + cert for the local HTTPS listener (CN=localhost). */
  key: string | Buffer;
  cert: string | Buffer;
  /** Real backend to forward to. */
  target: { host: string; port: number };
  /** Accept the backend's (self-signed) cert. Default true — backend TLS is ours. */
  insecureUpstream?: boolean;
  /** Bind host for the local listener. Default 127.0.0.1. */
  bindHost?: string;
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

  const server = https.createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    const upstream = https.request(
      {
        host: opts.target.host,
        port: opts.target.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
        rejectUnauthorized: !insecureUpstream,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
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
  logger.info(`tls-reverse-proxy: ${url} → ${opts.target.host}:${opts.target.port}`);

  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

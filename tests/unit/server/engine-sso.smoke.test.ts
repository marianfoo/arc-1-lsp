/**
 * Gated live smoke: arc-1-lsp's INTERACTIVE/SSO connection path end-to-end against a real
 * SAP system, WITHOUT a real browser. We inject `openUrl` (the SSO browser-opener seam) with
 * a shim that performs the reentrance GET itself — i.e. it plays the role the browser+IdP
 * would. This exercises config(authMode:sso) → engine builds `interactive` → logon connects.
 * The one thing it does NOT cover is the real IdP redirect (a4h is basic-auth, no SSO).
 *
 * Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is set. Reads only (search).
 */
import http from 'node:http';
import https from 'node:https';
import { resolveAdtLsPath } from '@marianfoo/adt-ls';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/server/config.js';
import { type Engine, startEngine } from '../../../src/server/engine.js';

let binPath: string | null = process.env.ARC1_ADT_LS_PATH ?? null;
if (!binPath) {
  try {
    binPath = resolveAdtLsPath();
  } catch {
    binPath = null;
  }
}
const pw = process.env.ARC1_TEST_SAP_PASSWORD;
const gated = !binPath || !pw;
const HOST = process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de';
const PORT = process.env.ARC1_TEST_SAP_PORT ?? '50001';
const USER = process.env.ARC1_TEST_SAP_USER ?? 'MARIAN';

/** GET without following redirects. Picks http/https by the URL (adt-ls's local
 *  ticket-delivery listener is plain HTTP; the proxy logon URL is HTTPS self-signed). */
function get(url: string, headers: Record<string, string>): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
        ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Stand in for "user signs in via the browser": GET the logon URL with creds → 307 +
 *  reentrance ticket → deliver to adt-ls's 127.0.0.1 listener. */
async function browserShim(url: string): Promise<void> {
  const auth = `Basic ${Buffer.from(`${USER}:${pw}`).toString('base64')}`;
  const r = await get(url, { Authorization: auth });
  if (r.location) await get(r.location.replace('localhost', '127.0.0.1'), {});
}

describe('startEngine SSO/interactive path (live — needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'connects via authMode:sso + an injected browser opener (no password in config)',
    async () => {
      // NOTE: no ARC1_SAP_PASSWORD — sso mode must connect without it.
      const config = loadConfig([], {
        ARC1_ADT_LS_PATH: binPath ?? undefined,
        ARC1_SAP_HOST: HOST,
        ARC1_SAP_PORT: PORT,
        ARC1_SAP_USER: USER, // optional hint
        ARC1_SAP_AUTH: 'sso',
        ARC1_SAP_DESTINATION: 'A4H',
      });
      expect(config.sapTarget?.authMode).toBe('sso');
      expect(config.sapTarget?.password).toBe(''); // no password needed

      engine = await startEngine(config, {
        openUrl: (url) => {
          void browserShim(url);
        },
      });

      expect(engine.connectedDestination).toBe('A4H');
      expect(engine.health().backendLive).toBe(true);

      const hits = await engine.search('CL_ABAP_TYPEDESCR', { types: ['CLAS/OC'] });
      expect(hits.length).toBeGreaterThan(0);
    },
    200_000,
  );

  it.skipIf(gated)(
    'SSO keep-warm holds the session alive past the idle-death point (no browser re-auth)',
    async () => {
      let opens = 0; // counts requestBrowserBasedLogon → openUrl (initial sign-in + any re-auth)
      const kwEngine = await startEngine(
        loadConfig([], {
          ARC1_ADT_LS_PATH: binPath ?? undefined,
          ARC1_SAP_HOST: HOST,
          ARC1_SAP_PORT: PORT,
          ARC1_SAP_USER: USER,
          ARC1_SAP_AUTH: 'sso',
          ARC1_SAP_DESTINATION: 'A4H',
        }),
        {
          openUrl: (url) => {
            opens++;
            void browserShim(url);
          },
        },
      );
      try {
        expect(kwEngine.connectedDestination).toBe('A4H');
        expect(opens).toBe(1); // signed in once
        // Idle 200s — well past a4h's ~90-135s idle death. The keep-warm probe (every 60s)
        // must keep the session alive WITHOUT a re-auth (no extra openUrl).
        await new Promise((r) => setTimeout(r, 200_000));
        const hits = await kwEngine.search('CL_ABAP_TYPEDESCR', { types: ['CLAS/OC'] });
        expect(hits.length).toBeGreaterThan(0); // still alive → keep-warm worked
        expect(opens).toBe(1); // and it never re-authed (no browser pop)
      } finally {
        await kwEngine.dispose();
      }
    },
    260_000,
  );
});

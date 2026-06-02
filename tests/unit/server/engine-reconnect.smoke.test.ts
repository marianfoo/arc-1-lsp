/**
 * Gated live test for the self-healing SAP session (engine.reconnect()).
 *
 * Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is set (never in CI).
 * Read-only against the live system — no mutations. Verifies the re-logon
 * mechanism that backs the automatic "logged off" recovery: ensureLoggedOn is
 * callable repeatedly and idempotent, and the connection still works after it.
 *
 * What it CANNOT verify cheaply: healing a session that has actually expired
 * server-side (that takes the backend's full inactivity timeout to reproduce).
 * The reconnect path reuses the exact logon proven at startup, so a green run
 * here is strong evidence the heal works; the true expiry path is exercised by
 * leaving the deployed instance idle. See docs/adt-ls-reference.md §7.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAdtLsPath } from '../../../src/adt-ls/discovery.js';
import { loadConfig } from '../../../src/server/config.js';
import { type Engine, startEngine } from '../../../src/server/engine.js';

let binPath: string | null = null;
try {
  binPath = resolveAdtLsPath();
} catch {
  binPath = null;
}
const password = process.env.ARC1_TEST_SAP_PASSWORD;
const gated = !binPath || !password;

describe('engine.reconnect (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    're-logs on idempotently and the connection still works (live a4h)',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
      });
      engine = await startEngine(config);
      expect(engine.connectedDestination).toBe('A4H');

      // baseline: a read works
      const before = await engine.search('CL_ABAP_CONTEXT_INFO', { maxResults: 1 });
      expect(before.length).toBeGreaterThan(0);

      // the self-heal lever — callable + idempotent (the mechanism re-logon uses)
      expect(await engine.reconnect()).toBe(true);
      expect(await engine.reconnect()).toBe(true);
      // a successful re-logon must mark the session live (health no longer reads false
      // after a heal — the DX#2 fix)
      expect(engine.health().backendLive).toBe(true);

      // connection still works after re-logon
      const after = await engine.search('CL_ABAP_CONTEXT_INFO', { maxResults: 1 });
      expect(after.length).toBeGreaterThan(0);
    },
    180000,
  );
});

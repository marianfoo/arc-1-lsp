/**
 * Gated live test — native CTS transport + lock READS (adtLs/cts/transport +
 * adtLs/fileSystem) against a real SAP system. READ-ONLY. Skips unless adt-ls is
 * present AND ARC1_TEST_SAP_PASSWORD is set (never in CI). Defaults to a4h.
 *
 * (assign_transport is NOT exercised live — it needs a transportable object + a real
 * transport request; $TMP objects need none. It is covered by unit tests.)
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

describe('native transport + lock reads (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'list_transports + get_lock_status (read-only)',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
      });
      engine = await startEngine(config);

      // list MY modifiable transports — an array (possibly empty); proves the native
      // searchTransports path (owner defaults to the logged-on user).
      const transports = await engine.lifecycle.listTransports();
      expect(Array.isArray(transports)).toBe(true);

      // lock status of a kernel class — {lockingSupported, lockId} (lockId null = unlocked).
      const lock = (await engine.lifecycle.getLockStatus({
        name: 'CL_ABAP_TYPEDESCR',
        objectType: 'CLAS/OC',
      })) as { lockingSupported?: unknown };
      expect(lock).toHaveProperty('lockingSupported');
    },
    180000,
  );
});

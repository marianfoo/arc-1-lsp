/**
 * Gated live test — the read tools wired in plan 07 (validate_object,
 * find_transport) against a real SAP system. READS ONLY (no mutation, no
 * cleanup). Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is set
 * (never in CI). Defaults to a4h. The mutating generate_objects is verified by
 * unit tests + a manual $TMP run (plan 07 Task 5) — not auto-run here, to avoid
 * orphaning a full RAP service.
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

describe('plan-07 read tools (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'validate_object + find_transport return a verdict for a $TMP class (read-only)',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
        // intentionally NO ARC1_ALLOW_WRITES — these are reads.
      });
      engine = await startEngine(config);
      expect(engine.connectedDestination).toBe('A4H');
      const lc = engine.lifecycle;

      const verdict = await lc.validateObject({
        objectType: 'CLAS/OC',
        name: 'ZCL_ARC1LSP_P07',
        packageName: '$TMP',
        description: 'plan07 probe',
      });
      // shape is captured into docs/adt-ls-reference.md after the first live run
      expect(verdict).toBeTruthy();

      const tr = await lc.findTransport({
        objectName: 'ZCL_ARC1LSP_P07',
        objectType: 'CLAS/OC',
        developmentPackage: '$TMP',
        isCreation: true,
      });
      expect(tr).toBeTruthy();
    },
    180000,
  );
});

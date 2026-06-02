/**
 * Gated live test — quality & test (ATC + ABAP Unit coverage) against a real SAP
 * system. READ-ONLY. Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is
 * set (never in CI). Defaults to a4h; uses the kernel class CL_ABAP_TYPEDESCR.
 *
 * Proves the WIRING (correct adtLs/atc + adtLs/abapUnit + adtLs/coverage method
 * names, reachable, right response shapes). ATC findings themselves depend on the
 * backend having check variants configured (a4h trial may have none) — the test
 * tolerates an empty variant set but fails if the method is unreachable.
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

describe('quality / ATC + coverage (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'list_atc_variants + run_atc + run_unit_tests_with_coverage (read-only)',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
      });
      engine = await startEngine(config);
      const q = engine.quality;
      const ref = { name: 'CL_ABAP_TYPEDESCR', objectType: 'CLAS/OC' };

      // getCheckVariants (with the "*" wildcard) returns the configured variants.
      // a4h has a rich set (CI_INA1_CONSISTENCY, CHECKMAN_SECURITY, ACTIVATION, …) —
      // live-verified, correcting the earlier "empty variants" probe artifact.
      const variants = (await q.listAtcVariants(ref)) as { checkVariants?: Record<string, string> };
      expect(variants).toHaveProperty('checkVariants');
      expect(Object.keys(variants.checkVariants ?? {}).length).toBeGreaterThan(0);

      // run ATC with the system default variant (empty checkVariant) — the backend
      // busy-polls to completion and returns the findings array (0 on a clean kernel class).
      const atc = (await q.runAtc(ref)) as { atcRunCheckResults?: unknown[] };
      expect(Array.isArray(atc.atcRunCheckResults)).toBe(true);

      // coverage: the kernel class has no own ABAP Unit tests → coverage null, but the
      // two-phase runTests→getCoverage wiring must complete and return the shape.
      const cov = (await q.runUnitTestsWithCoverage(ref)) as {
        status: unknown;
        result: unknown;
        coverage: unknown;
      };
      expect(cov).toHaveProperty('coverage');
      expect(cov).toHaveProperty('status');
      expect(cov).toHaveProperty('result');
    },
    240000,
  );
});

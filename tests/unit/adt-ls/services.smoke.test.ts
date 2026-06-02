/**
 * Gated live test — run_application (adtLs/run) end-to-end against a real SAP
 * system. Creates a $TMP class implementing if_oo_adt_classrun, activates it, runs
 * it, and asserts its console output, then deletes it. Skips unless adt-ls is
 * present AND ARC1_TEST_SAP_PASSWORD is set (never in CI; mutates only $TMP +
 * cleans up). Defaults to a4h.
 *
 * (publish_service_binding is NOT exercised live — adt-ls toggles published state,
 * so running it on a real binding would flip it; it is covered by unit tests.)
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

const NAME = 'ZCL_ARC1LSP_RUNTEST';
const TYPE = 'CLAS/OC';
const MARKER = 'arc1lsp run ok';
const SOURCE = `CLASS zcl_arc1lsp_runtest DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.
CLASS zcl_arc1lsp_runtest IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    out->write( |${MARKER}| ).
  ENDMETHOD.
ENDCLASS.`;

describe('run_application (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    try {
      await engine?.lifecycle.deleteObject({ name: NAME, objectType: TYPE });
    } catch {
      /* already gone */
    }
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'creates a $TMP classrun class, runs it, and captures its console output',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
        ARC1_ALLOW_WRITES: 'true',
        ARC1_ALLOWED_PACKAGES: '$TMP',
      });
      engine = await startEngine(config);
      const lc = engine.lifecycle;

      await lc.deleteObject({ name: NAME, objectType: TYPE }).catch(() => {}); // clean slate
      await lc.createObject({ objectType: TYPE, name: NAME, packageName: '$TMP', description: 'arc-1-lsp run test' });
      await lc.updateSource({ name: NAME, objectType: TYPE, source: SOURCE });
      const act = await lc.activate({ name: NAME, objectType: TYPE });
      expect(act.success).toBe(true);

      // run it → console output must contain the marker the class wrote
      const run = (await engine.services.runApplication({ name: NAME, objectType: TYPE })) as { output: string };
      expect(run.output).toContain(MARKER);

      // service_binding_details (read-only) on a standard /DMO/ binding — proves the
      // native srvb segment + the SFS warm-up (readFile-first, else "Unsupported Object
      // Type"). publish is NOT exercised (toggles state) — unit-tested only.
      const srvb = await engine.services.serviceBindingDetails({
        name: '/DMO/API_TRAVEL_U_V2',
        objectType: 'SRVB/SVB',
      });
      expect(JSON.stringify(srvb)).toMatch(/API_TRAVEL_U_V2|ODATA/);

      await lc.deleteObject({ name: NAME, objectType: TYPE });
    },
    180000,
  );
});

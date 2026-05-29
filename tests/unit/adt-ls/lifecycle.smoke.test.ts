/**
 * Gated live lifecycle test — the full authoring loop against a real SAP system:
 * create → update source → read → activate → run unit tests → delete, in $TMP.
 * Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is set (never in CI;
 * mutates only $TMP and cleans up). Defaults to a4h.
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

const NAME = 'ZCL_ARC1LSP_LCTEST';
const TYPE = 'CLAS/OC';
const SOURCE = `CLASS zcl_arc1lsp_lctest DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS hello RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_arc1lsp_lctest IMPLEMENTATION.
  METHOD hello.
    rv = 'hi'.
  ENDMETHOD.
ENDCLASS.`;

describe('authoring loop (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    // best-effort cleanup in case the test failed mid-flight
    try {
      await engine?.lifecycle.deleteObject({ name: NAME, objectType: TYPE });
    } catch {
      /* already gone */
    }
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'creates → updates → reads → activates → tests → deletes a $TMP class',
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
      expect(engine.connectedDestination).toBe('A4H');
      const lc = engine.lifecycle;

      // clean slate
      await lc.deleteObject({ name: NAME, objectType: TYPE }).catch(() => {});

      // create
      const created = await lc.createObject({
        objectType: TYPE,
        name: NAME,
        packageName: '$TMP',
        description: 'arc-1-lsp lifecycle test',
      });
      expect(created.filePath).toMatch(/zcl_arc1lsp_lctest\.clas\.abap$/i);

      // update source + read back
      await lc.updateSource({ name: NAME, objectType: TYPE, source: SOURCE });
      const src = await lc.readSource({ name: NAME, objectType: TYPE });
      expect(src).toMatch(/METHODS hello/i);

      // activate (should succeed, no diagnostics)
      const act = await lc.activate({ name: NAME, objectType: TYPE });
      expect(act.success).toBe(true);
      expect(act.diagnostics).toEqual([]);

      // run unit tests (none defined → call succeeds)
      const tests = await lc.runUnitTests({ name: NAME, objectType: TYPE });
      expect(JSON.stringify(tests)).toMatch(/no tests found|testClasses|durationCategory/i);

      // delete + confirm gone (read should now fail)
      await lc.deleteObject({ name: NAME, objectType: TYPE });
      await expect(lc.readSource({ name: NAME, objectType: TYPE })).rejects.toBeTruthy();
    },
    180000,
  );
});

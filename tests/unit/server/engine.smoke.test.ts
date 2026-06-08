/**
 * Gated live smoke: the full authoring loop through the lib-backed `startEngine` adapter
 * against a real SAP system. Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is
 * set (never in CI; mutates only $TMP and cleans up). Defaults to a4h.
 */
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

const NAME = 'ZCL_ARC1LSP_ENGTEST';
const TYPE = 'CLAS/OC';
const SOURCE = `CLASS zcl_arc1lsp_engtest DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS hello RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_arc1lsp_engtest IMPLEMENTATION.
  METHOD hello.
    rv = 'hi'.
  ENDMETHOD.
ENDCLASS.`;

describe('startEngine (live — needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
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
    'connects + runs the full $TMP lifecycle through the lib-backed engine',
    async () => {
      const config = loadConfig([], {
        ARC1_ADT_LS_PATH: binPath ?? undefined,
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'MARIAN',
        ARC1_SAP_PASSWORD: pw,
        ARC1_SAP_DESTINATION: 'A4H',
        ARC1_ALLOW_WRITES: 'true',
        ARC1_ALLOWED_PACKAGES: '$TMP',
      });
      engine = await startEngine(config);
      expect(engine.connectedDestination).toBe('A4H');
      expect(engine.health().backendLive).toBe(true);
      expect(engine.health().adtLs.version).toMatch(/1\.0\.0/);

      const hits = await engine.search('CL_ABAP_TYPEDESCR', { types: ['CLAS/OC'] });
      expect(hits.length).toBeGreaterThan(0);

      await engine.lifecycle.deleteObject({ name: NAME, objectType: TYPE }).catch(() => {});
      const created = await engine.lifecycle.createObject({
        objectType: TYPE,
        name: NAME,
        packageName: '$TMP',
        description: 'arc-1-lsp engine adapter test',
      });
      expect(created.filePath).toMatch(/zcl_arc1lsp_engtest\.clas\.abap$/i);

      await engine.lifecycle.updateSource({ name: NAME, objectType: TYPE, source: SOURCE });
      const src = await engine.lifecycle.readSource({ name: NAME, objectType: TYPE });
      expect(src).toMatch(/METHODS hello/i);

      const act = await engine.lifecycle.activate({ name: NAME, objectType: TYPE });
      expect(act.success).toBe(true);
      expect(act.diagnostics).toEqual([]);

      await engine.lifecycle.deleteObject({ name: NAME, objectType: TYPE });
    },
    200_000,
  );
});

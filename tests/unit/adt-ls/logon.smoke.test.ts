/**
 * Gated end-to-end logon test: boots the REAL engine (adt-ls + TLS reverse proxy
 * + headless reentrance logon) against a live SAP system and asserts it reaches
 * `connected` + a real backend call returns data. Reproduces the proven spike
 * through the committed engine code.
 *
 * Skips unless BOTH an adt-ls binary is discoverable AND `ARC1_TEST_SAP_PASSWORD`
 * is set — so it never runs in CI and never hits SAP without explicit creds.
 * Defaults target a4h; override via ARC1_TEST_SAP_{HOST,PORT,USER}.
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

describe('engine headless logon (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'connects to the SAP system and returns real backend data',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
        ARC1_SAP_CLIENT: process.env.ARC1_TEST_SAP_CLIENT ?? '001',
      });

      engine = await startEngine(config);
      expect(engine.connectedDestination).toBe('A4H');
      expect(engine.health().connectedDestination).toBe('A4H');

      const result = await engine.callTool('abap_creation-get_all_creatable_objects', { destination: 'A4H' });
      // Real ABAP object catalog from the backend (e.g. CLAS/OC, BDEF/BDO).
      expect(JSON.stringify(result)).toContain('creatableObjects');

      // search_objects (LSP quickSearch) returns a real repository hit.
      const hits = await engine.search('CL_ABAP_TYPEDESCR', { maxResults: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.name?.toUpperCase() === 'CL_ABAP_TYPEDESCR')).toBe(true);
      expect(hits[0].uri).toContain('/sap/bc/adt/');

      // list_inactive_objects works (array; may be empty).
      expect(Array.isArray(await engine.listInactiveObjects())).toBe(true);

      // list_users returns the system users (DEVELOPER is on a4h).
      const users = await engine.listUsers();
      expect(users.some((u) => u.id?.toUpperCase() === 'DEVELOPER')).toBe(true);

      // list_generators (federated) returns ≥1 generator.
      const gens = await engine.callTool('abap_generators-list_generators', { destination: 'A4H' });
      expect(JSON.stringify(gens)).toContain('generators');

      // get_service_binding: find an SRVB via search, then fetch its OData info.
      const srvbs = await engine.search('*', { maxResults: 50, types: ['SRVB/SVB'] });
      if (srvbs[0]?.name) {
        const binding = await engine.callTool('abap_business_services-fetch_services', {
          destination: 'A4H',
          serviceBindingName: srvbs[0].name,
        });
        expect(JSON.stringify(binding)).toMatch(/bindingType|odata/i);
      }
    },
    120000,
  );
});

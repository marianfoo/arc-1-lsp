/**
 * Gated live smoke: arc-1-lsp's `clientcert` (X.509 mutual TLS) connection path end-to-end
 * against a real cert-logon backend — passwordless, NO browser. The lib's reverse proxy
 * presents the client cert upstream; the backend maps it to a user (e.g. AS ABAP
 * `verify_client` + CERTRULE). Skips unless adt-ls is present AND ARC1_TEST_CLIENT_CERT/_KEY
 * (PEM file paths) are set. Reads only (search).
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
const certPath = process.env.ARC1_TEST_CLIENT_CERT;
const keyPath = process.env.ARC1_TEST_CLIENT_KEY;
const gated = !binPath || !certPath || !keyPath;
const HOST = process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de';
const PORT = process.env.ARC1_TEST_SAP_PORT ?? '50001';
const USER = process.env.ARC1_TEST_SAP_USER ?? 'MARIAN';

describe('startEngine clientcert path (live — needs adt-ls + ARC1_TEST_CLIENT_CERT/_KEY)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'connects passwordless via X.509 mutual TLS + runs a real search',
    async () => {
      // NOTE: no ARC1_SAP_PASSWORD — clientcert must connect without it.
      const config = loadConfig([], {
        ARC1_ADT_LS_PATH: binPath ?? undefined,
        ARC1_SAP_HOST: HOST,
        ARC1_SAP_PORT: PORT,
        ARC1_SAP_USER: USER,
        ARC1_SAP_AUTH: 'clientcert',
        ARC1_SAP_CLIENT_CERT: certPath,
        ARC1_SAP_CLIENT_KEY: keyPath,
        ARC1_SAP_DESTINATION: 'A4H',
      });
      expect(config.sapTarget?.authMode).toBe('clientcert');
      expect(config.sapTarget?.password).toBe(''); // no password needed

      engine = await startEngine(config);

      expect(engine.connectedDestination).toBe('A4H');
      expect(engine.health().backendLive).toBe(true);

      const hits = await engine.search('CL_ABAP_TYPEDESCR', { types: ['CLAS/OC'] });
      expect(hits.length).toBeGreaterThan(0);
    },
    120_000,
  );
});

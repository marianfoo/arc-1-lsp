/**
 * Gated live test — LSP code-intelligence (plan 11) against a real SAP system.
 * READ-ONLY. Skips unless adt-ls is present AND ARC1_TEST_SAP_PASSWORD is set
 * (never in CI). Defaults to a4h; uses the kernel class CL_ABAP_TYPEDESCR.
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

describe('navigation / code-intelligence (needs adt-ls + ARC1_TEST_SAP_PASSWORD)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(gated)(
    'documentSymbols + checkSyntax + definition + type hierarchy (read-only)',
    async () => {
      const config = loadConfig([], {
        ARC1_SAP_HOST: process.env.ARC1_TEST_SAP_HOST ?? 'a4h.marianzeis.de',
        ARC1_SAP_PORT: process.env.ARC1_TEST_SAP_PORT ?? '50001',
        ARC1_SAP_USER: process.env.ARC1_TEST_SAP_USER ?? 'DEVELOPER',
        ARC1_SAP_PASSWORD: password,
        ARC1_SAP_DESTINATION: 'A4H',
      });
      engine = await startEngine(config);
      const nav = engine.navigation;
      const ref = { name: 'CL_ABAP_TYPEDESCR', objectType: 'CLAS/OC' };

      const symbols = await nav.documentSymbols(ref);
      expect(JSON.stringify(symbols)).toMatch(/CL_ABAP_TYPEDESCR/);

      const syntax = await nav.checkSyntax(ref);
      expect(JSON.stringify(syntax)).toMatch(/"items"/); // {kind:'full', items:[…]}

      const def = await nav.goToDefinition(ref, { symbol: 'CL_ABAP_TYPEDESCR' });
      expect(Array.isArray(def) && def.length > 0).toBe(true);

      // type hierarchy by class name → must resolve to the NAME (not the keyword) and return subtypes
      const th = (await nav.typeHierarchy(ref, { symbol: 'CL_ABAP_TYPEDESCR' }, { direction: 'subtypes' })) as {
        subtypes?: unknown;
      };
      expect(JSON.stringify(th.subtypes)).toMatch(/CL_ABAP_OBJECTDESCR/);

      // HOVER — the headline fix (capability-map §3a): priming textDocument/semanticTokens/full
      // populates AbapDocumentTokenCache so AbapTokenFilterService.shouldCallBackend passes.
      // Without the prime this is null at every position. Expect rich markdown now.
      const hover = (await nav.hover(ref, { symbol: 'CL_ABAP_TYPEDESCR' })) as {
        contents?: { value?: string };
      } | null;
      expect(hover, 'hover must be non-null once semanticTokens primes the token cache').not.toBeNull();
      expect(JSON.stringify(hover)).toMatch(/CL_ABAP_TYPEDESCR|class|interface/i);

      // documentHighlight — same backend gate as hover; occurrences within the document.
      const highlights = await nav.documentHighlight(ref, { symbol: 'CL_ABAP_TYPEDESCR' });
      expect(Array.isArray(highlights)).toBe(true);

      // declaration — LocationLink[] (no priming needed).
      const decl = await nav.goToDeclaration(ref, { symbol: 'CL_ABAP_TYPEDESCR' });
      expect(Array.isArray(decl) && (decl as unknown[]).length > 0).toBe(true);
    },
    180000,
  );
});

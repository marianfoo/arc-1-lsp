/**
 * Gated smoke test: requires a real adt-ls binary on the machine. If none is
 * discoverable, the test skips (keeps CI green). On a dev machine with the
 * sapse.adt-vscode extension installed, it spawns adt-ls headless for real.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAdtLsPath } from '../../../src/adt-ls/discovery.js';
import { AdtLsDriver } from '../../../src/adt-ls/driver.js';

let binPath: string | null = null;
try {
  binPath = resolveAdtLsPath();
} catch {
  binPath = null;
}

describe('AdtLsDriver (smoke — needs a real adt-ls)', () => {
  let driver: AdtLsDriver | undefined;
  afterAll(async () => {
    await driver?.dispose();
  });

  it.skipIf(!binPath)(
    'spawns adt-ls headless and completes LSP initialize',
    async () => {
      driver = new AdtLsDriver(binPath as string);
      const res = await driver.start();
      expect(res.serverInfo?.name).toMatch(/ADTLS/i);
      expect(Object.keys(res.capabilities)).toEqual(
        expect.arrayContaining(['completionProvider', 'diagnosticProvider']),
      );
    },
    60000,
  );
});

/**
 * End-to-end foundation smoke test: discover → spawn adt-ls headless → start its
 * MCP server over LSP → federate → assert the full chain. Gated on a real adt-ls
 * binary (skips in CI). Kills the JVM in afterAll so no orphan is left.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { resolveAdtLsPath } from '../../src/adt-ls/discovery.js';
import type { Arc1LspConfig } from '../../src/server/config.js';
import { type Engine, startEngine } from '../../src/server/engine.js';

let hasBinary = false;
try {
  resolveAdtLsPath();
  hasBinary = true;
} catch {
  hasBinary = false;
}

const config: Arc1LspConfig = {
  adtLsMcpPort: 2241, // distinct from VS Code's 2236 and the default 2240
  transport: 'stdio',
  httpPort: 8080,
};

describe('foundation smoke (full chain — needs a real adt-ls)', () => {
  let engine: Engine | undefined;
  afterAll(async () => {
    await engine?.dispose();
  });

  it.skipIf(!hasBinary)(
    'boots adt-ls headless, starts its MCP, and federates ≥14 tools',
    async () => {
      engine = await startEngine(config);

      const health = engine.health();
      expect(health.adtLs.up).toBe(true);
      expect(health.adtLs.name).toMatch(/ADTLS/i);
      expect(health.mcpPort).toBe(2241);

      const tools = await engine.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(14);
      expect(tools.map((t) => t.name)).toContain('abap_list_destinations');
    },
    90000,
  );
});

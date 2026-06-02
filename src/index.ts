#!/usr/bin/env node
/**
 * arc-1-lsp entry point. Boots the embedded adt-ls engine and serves an MCP
 * server. Foundation supports stdio; the http-streamable transport (needed for
 * the BTP CF deploy) lands in the deploy plan.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { detectLegacySapEnvWarnings, loadConfig } from './server/config.js';
import { startEngine } from './server/engine.js';
import { startHttpServer } from './server/http.js';
import { logger } from './server/logger.js';
import { createMcpServer } from './server/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  for (const w of detectLegacySapEnvWarnings()) logger.warn(`config: ${w}`);
  const engine = await startEngine(config);

  if (config.transport === 'http-streamable') {
    startHttpServer(() => createMcpServer(engine), config);
  } else {
    await createMcpServer(engine).connect(new StdioServerTransport());
    logger.info('arc-1-lsp MCP server ready (stdio)');
  }

  const shutdown = async () => {
    logger.info('shutting down…');
    await engine.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

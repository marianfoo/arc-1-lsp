# CLAUDE.md — arc-1-lsp

Guidance for Claude Code working in this repo. Read first.

## What this is

`arc-1-lsp` is an ARC-1 edition that **delegates all ABAP/ADT work to SAP's
embedded `adt-ls`** (headless Eclipse LS from `sapse.adt-vscode`). It is the
single-developer / desktop sibling to the main multi-user/BTP ARC-1. The main
ARC-1 lives at `../arc-1`; deep background on the design and the `adt-ls`
internals is in `../arc-1/docs/research/{arc1-embedded-adt-ls-edition,sapse-adt-vscode-mcp}.md`.

## Design principles (non-negotiable)

1. **Zero hand-rolled ADT.** Never port `src/adt/{http,crud,xml-parser,…}` from
   ARC-1. CSRF, locking, XML, activation, transport all live in `adt-ls`.
2. **BYO `adt-ls`.** Never bundle/commit the binary (SAP Developer License).
   Discover a developer-provided one (`src/adt-ls/discovery.ts`).
3. **Reuse ARC-1's shell.** MCP server, auth (API key first, XSUAA later), scope
   policy, audit, stderr logging, Zod schemas — adapt, don't reinvent.
4. **Two channels to `adt-ls`.** MCP federation (stable, primary for tools) +
   LSP (rich language intelligence, later). Foundation uses LSP only to
   bootstrap + start the MCP server.
5. **stdout is sacred.** Logging → stderr only (`src/server/logger.ts`). ESM-only,
   `.js` import extensions, TS strict, Biome (2-space/single-quote/120).

## Codebase

```
src/
├── index.ts                 # entry (stdio; http-streamable in the deploy plan)
├── adt-ls/
│   ├── discovery.ts         # locate adt-ls (env > vendor > installed ext; per-platform)
│   ├── driver.ts            # spawn headless + LSP over named pipe (vscode-jsonrpc)
│   ├── mcp-lifecycle.ts     # adtLs/mcp/{startMCPServer,stopMCPServer,setDestination}
│   └── mcp-federation.ts    # Streamable-HTTP client to adt-ls's own /mcp
└── server/
    ├── config.ts            # loadConfig (CLI > env > default)
    ├── logger.ts            # stderr-only logger
    ├── engine.ts            # discover → spawn → startMCP → federate
    └── server.ts            # McpServer + tool registration (health, list_destinations)
tests/unit/…                 # vitest; adt-ls-dependent tests are skipIf-gated
docs/plans/…                 # ralphex plans (one per roadmap state)
```

## Key facts about `adt-ls`

- Launch: `adt-ls -Djco.trace_path <dir> -data <dir> --pipe=<unix-socket>`
  (client listens on the pipe, LS connects). serverInfo `ADTLS 1.0.0.<build>`.
- Custom LSP namespace `adtLs/*`: `mcp/{startMCPServer,stopMCPServer,setDestination}`,
  `destinations/{create,ensureLoggedOn,list,…}`, `fileSystem/{readFile,writeFile,
  lockFile,unlockFile,…}`, `activation/activate`, `cts/transport/*`,
  `abapUnit/runTests`, `atc/runCheck`, `businessservice/srvb/*` — full map in
  the ARC-1 research doc.
- Auth kinds it supports: `BASIC_AUTH`, `OAUTH` (Bearer/PKCE), `SSO`,
  `SAML_WITH_REENTRANCE_TICKET`. The VS Code UI only exposes SSO/reentrance;
  basic auth is configurable in `destinations.json` (used for the fixed-user
  deploy and the per-user PP proxy).

## Workflow (the loop)

Per roadmap state: create a ralphex plan in `docs/plans/` (`.claude/commands/
ralphex-plan.md`), self-review, implement, test, review, advance. Every
code-changing task includes tests. adt-ls-dependent tests must `skipIf` when no
binary is present so CI stays green.

## Build & test

```bash
npm run build       # tsc → dist/
npm test            # vitest (smoke tests run for real when adt-ls is present)
npm run typecheck
npm run lint        # biome
```

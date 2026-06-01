# Contributing to arc-1-lsp

Thanks for your interest! arc-1-lsp is a thin MCP server that delegates all
ABAP/ADT work to SAP's embedded `adt-ls`. The hard rule that shapes everything:
**arc-1-lsp does no ADT protocol itself** — every SAP operation goes through
`adt-ls` (ADR-0003). Read [`CLAUDE.md`](CLAUDE.md) for the design principles and
codebase map before a substantial change.

## Prerequisites

- **Node.js 22+**.
- **A `adt-ls` binary (BYO).** It ships inside SAP's `sapse.adt-vscode` VS Code
  extension under a SAP Developer License and is **never committed or
  redistributed** (ADR-0002). Provide one of:
  - install the `sapse.adt-vscode` extension (auto-discovered from
    `~/.vscode/extensions`), **or**
  - `ARC1_ADT_LS_PATH=/path/to/adt-ls`, **or**
  - `node scripts/extract-adt-ls.mjs` to inject it into `vendor/adt-ls/` for a
    container build.

## Build, test, lint

```bash
npm ci
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run lint        # biome check (run lint:fix to auto-fix)
npm test            # vitest (unit; adt-ls/SAP-dependent tests self-skip)
```

All four must pass. There is no pre-commit hook — run them yourself (CI runs them
on every PR).

## Tests & the skip convention

- Pure unit tests run everywhere and must stay green with **no** adt-ls and **no**
  SAP system.
- Tests that need a real `adt-ls` are gated on `resolveAdtLsPath()` and skip when
  it's absent. Tests that need a SAP system are additionally gated on
  `ARC1_TEST_SAP_PASSWORD` and **never run in CI**.
- Live tests must mutate only **`$TMP`** and clean up after themselves
  (`try/finally` delete). A hung test that skips cleanup orphans an object —
  verify with `search_objects`.
- Every code change needs tests. Mirror the existing patterns (fake driver +
  `callTool` recorder in `tests/unit/adt-ls/lifecycle.test.ts`; in-memory MCP
  client in `tests/unit/server/server.test.ts`).

## Adding an adt-ls-backed tool

1. **Read [`docs/adt-ls-reference.md`](docs/adt-ls-reference.md) first** — the
   authoritative, live-verified capability map (URI model, the `getLsUri`
   resolver, the object-type boundary, the proven lifecycle, gotchas).
2. Confirm the exact backend tool name + input schema from adt-ls's own
   `tools/list` (no SAP backend needed) — don't hand-guess schemas.
3. Mutations go through `src/adt-ls/lifecycle.ts` behind the write-safety layer
   (`src/server/safety.ts`); reads can be thin passthroughs in `src/server/server.ts`.
4. **Record any new adt-ls finding back in `adt-ls-reference.md`** (exact call +
   observed result) — that's the doc's whole purpose.

## Code style

- **ESM-only.** Local imports use `.js` extensions (`import { x } from './y.js'`).
- **Biome** owns format + lint: 2-space indent, single quotes, semicolons,
  trailing commas, 120-col. Don't hand-format — `npm run lint:fix`.
- **Logging goes to stderr** via `src/server/logger.ts`. Never `console.log`
  (stdout carries MCP JSON-RPC in stdio mode).

## Commits & releases

- **Conventional Commits** drive releases via release-please: `feat:` → minor,
  `fix:` → patch, `feat!:`/`BREAKING CHANGE:` → major; `docs:`/`chore:`/`ci:` →
  no release. The version lives once in [`src/version.ts`](src/version.ts) and
  `package.json` (release-please bumps both).
- Decisions → an ADR in [`docs/adr/`](docs/adr/); larger work → a plan in
  [`docs/plans/`](docs/plans/) (move to `completed/` when done).

## Never commit

Secrets (`.env`, service keys, cookies, passwords) or the `adt-ls` binary. See
[`SECURITY.md`](SECURITY.md).

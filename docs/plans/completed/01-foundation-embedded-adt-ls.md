# Foundation — embedded adt-ls driver + minimal MCP server

## Overview

`arc-1-lsp` is a separate edition of ARC-1 that **delegates all SAP/ADT
interaction to SAP's `adt-ls`** (the headless Eclipse ABAP language server
bundled in the `sapse.adt-vscode` extension) instead of ARC-1's hand-rolled ADT
HTTP client. The goal of this foundation plan is the thinnest end-to-end slice:
spawn a developer-provided `adt-ls` headless, boot its MCP server over LSP, and
expose a minimal ARC-1-shaped MCP server in front of it — proving the
architecture locally before containerization (Step 3) and BTP CF deploy (Step 4).

The riskiest unknown — *can `adt-ls` be driven headless from Node?* — is already
**proven** (see `docs/research/` validation: LSP `initialize` in ~230 ms, then
`adtLs/mcp/startMCPServer` brought up the MCP server and `tools/list` returned
14 tools, with no VS Code and no SAP credentials). This plan productionizes that
spike.

Key design decision: **reuse ARC-1's *shell* (MCP server setup, auth, scope
policy, audit, stderr logging, tool-schema conventions), delete ARC-1's *engine*
(`src/adt/*` — http, crud, xml-parser, safety transport).** The engine is now
`adt-ls`.

## Context

### Current State
- Empty repo scaffold at `/Users/marianzeis/DEV/arc-1-lsp` (git initialized,
  `.claude/commands/ralphex-plan.md` copied, empty `src/`, `docs/`, `tests/`).
- `adt-ls` boot path proven via throwaway spikes (`/tmp/adtls-spike/*.mjs`).
- The full `adt-ls` custom LSP surface is mapped in the ARC-1 repo at
  `docs/research/arc1-embedded-adt-ls-edition.md`.

### Target State
- `npm run dev` (stdio) or `npm run dev:http` starts an MCP server that:
  1. discovers a developer-provided `adt-ls` binary,
  2. spawns it headless and completes LSP `initialize`,
  3. starts `adt-ls`'s MCP server over LSP (`adtLs/mcp/startMCPServer`),
  4. exposes a minimal ARC-1 MCP surface (`list_destinations`, `health`) that
     federates to the embedded `adt-ls` MCP endpoint.
- A gated smoke test boots the whole chain locally and asserts `tools/list`.
- No SAP credentials, no VS Code, no network required for the boot/list path.

### Key Files

| File | Role |
|------|------|
| `package.json` / `tsconfig.json` / `biome.json` / `vitest.config.ts` | TS/ESM project config (mirror ARC-1 conventions) |
| `.gitignore` | must ignore `vendor/adt-ls/` (never commit SAP binaries) |
| `src/adt-ls/discovery.ts` | locate the `adt-ls` binary (env > vendor > installed VS Code ext) |
| `src/adt-ls/driver.ts` | spawn `adt-ls` headless, LSP client over named pipe, lifecycle |
| `src/adt-ls/mcp-lifecycle.ts` | `startMCPServer`/`stopMCPServer`/`setDestination` LSP wrappers |
| `src/adt-ls/mcp-federation.ts` | Streamable-HTTP client to `adt-ls`'s `/mcp` (bearer) |
| `src/server/server.ts` | ARC-1-shaped MCP server registration (adapted from arc-1) |
| `src/server/logger.ts` | stderr-only structured logger (port from arc-1) |
| `src/server/config.ts` | config parser (CLI > env > defaults), incl. `ARC1_ADT_LS_PATH` |
| `src/handlers/tools.ts` | minimal tool definitions (`list_destinations`, `health`) |
| `src/index.ts` | MCP server entry (stdio + http-streamable) |
| `tests/unit/adt-ls/*.test.ts` | unit + gated smoke tests |

### Design Principles
- **Zero hand-rolled ADT.** Do NOT port `src/adt/{http,crud,xml-parser,
  discovery,devtools,...}` from ARC-1. All ADT/CSRF/locking/XML lives in
  `adt-ls`. arc-1-lsp only orchestrates.
- **BYO `adt-ls`.** Never bundle or commit the binary. Discover a
  developer-provided one. `.gitignore` `vendor/adt-ls/`.
- **Reuse ARC-1's shell.** MCP server, auth (API key first; XSUAA later), scope
  policy, audit, stderr logging, Zod schemas — adapt from ARC-1, don't reinvent.
- **Single-user/desktop foundation.** Multi-user principal propagation is a
  later plan (the auth-injecting sidecar proxy); do not build it here.
- **Two channels to `adt-ls`.** MCP federation (stable, primary for tools) now;
  the rich LSP language-intelligence channel (completion/hover/where-used) is a
  later plan. Foundation uses LSP only to bootstrap + start the MCP server.
- **stdout is sacred.** All logging to stderr; stdout carries MCP JSON-RPC only.
  ESM-only, `.js` import extensions, TS strict (mirror ARC-1).

## Development Approach

Build foundation-first: project config → discovery → driver → MCP lifecycle →
federation → server/tools → smoke test → docs. Each task ends green on
`npm run build` + `npm test`. The driver/smoke tests that require a real
`adt-ls` binary must use a skip helper (`requireOrSkip`-style) so CI without the
binary stays green; when the binary is present (this dev machine) they run for
real. Use `vscode-jsonrpc` for the LSP client (named-pipe transport) rather than
hand-rolled Content-Length framing.

## Validation Commands

- `npm run build`
- `npm test`
- `npm run typecheck`
- `npm run lint`

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`,
  `.gitignore`, `src/index.ts` (placeholder), `README.md`

Set up a TS/ESM project mirroring ARC-1's conventions (Node 22+, `"type":
"module"`, strict TS, Node16 resolution, Biome 2-space/single-quote/120-width).

- [ ] `package.json`: name `arc-1-lsp`, bin `arc1-lsp` → `dist/index.js`, deps
  `@modelcontextprotocol/sdk`, `vscode-jsonrpc`, `zod`, `commander`, `undici`;
  devDeps `typescript`, `@biomejs/biome`, `vitest`, `@types/node`. Scripts:
  `build` (tsc), `dev`, `dev:http`, `test`, `typecheck`, `lint`.
- [ ] `.gitignore`: `node_modules/`, `dist/`, `vendor/adt-ls/`, `*.log`,
  `.env`, `.arc1-cache.db`.
- [ ] `tsconfig.json`: strict, `module`/`moduleResolution` Node16, `outDir
  dist`, `rootDir src`, `noUnusedLocals/Parameters`.
- [ ] `src/index.ts`: minimal placeholder that compiles.
- [ ] Run `npm install` then `npm run build` — compiles clean.

### Task 2: adt-ls binary discovery

**Files:**
- Create: `src/adt-ls/discovery.ts`, `tests/unit/adt-ls/discovery.test.ts`

Locate a developer-provided `adt-ls`. Resolution order: `ARC1_ADT_LS_PATH` env →
`vendor/adt-ls/` in the repo → newest installed `sapse.adt-vscode-*` VS Code
extension. Per-platform sub-path: darwin `macosx/cocoa/<arch>/Adt-ls.app/
Contents/MacOS/adt-ls`; linux `linux/gtk/<arch>/adt-ls`; win32 `win32/win32/
<arch>/adt-lsc.exe`. Arch maps arm64→aarch64, x64→x86_64.

- [ ] `resolveAdtLsPath(opts?)` returns an absolute path or throws a clear error
  listing the locations tried.
- [ ] Helper `platformSubPath(platform, arch)` pure function.
- [ ] Add unit tests (~6 tests): env override wins; vendor dir; extension glob
  (use a temp dir fixture); per-platform path mapping; missing-binary error
  message lists tried paths.
- [ ] Run `npm test` — all tests must pass.

### Task 3: AdtLsDriver (spawn + LSP)

**Files:**
- Create: `src/adt-ls/driver.ts`, `tests/unit/adt-ls/driver.smoke.test.ts`

Spawn `adt-ls` headless and speak LSP over a named pipe, mirroring how the
`sapse.adt-vscode` extension launches it: args `["-Djco.trace_path", <dataDir>,
"-data", <dataDir>]` plus `--pipe=<generatedPipeName>`; the client listens on the
pipe, `adt-ls` connects. Use `vscode-jsonrpc` (`createMessageConnection` over the
socket) for framing. Provide `start()` (spawn + `initialize` + `initialized`),
`sendRequest(method, params)`, `dispose()` (kill child, close socket). Log
`adt-ls` stderr to our stderr logger. Use a unique temp `-data` dir per instance.

- [ ] `AdtLsDriver` class: `start()` resolves after `initialize` returns
  serverInfo; stores capabilities.
- [ ] Robust lifecycle: kill child on `dispose()`; handle premature exit
  (reject pending start with the captured stderr tail).
- [ ] Add a **gated** smoke test: if `resolveAdtLsPath()` finds no binary,
  `requireOrSkip`-style skip; otherwise assert `start()` returns serverInfo
  `ADTLS …` and capabilities include `completionProvider` + `diagnosticProvider`.
- [ ] Run `npm test` — passes (smoke runs for real on this machine; skips in CI).

### Task 4: MCP lifecycle wrappers over LSP

**Files:**
- Modify: `src/adt-ls/driver.ts`
- Create: `src/adt-ls/mcp-lifecycle.ts`, `tests/unit/adt-ls/mcp-lifecycle.test.ts`

Thin wrappers over the proven custom LSP requests: `startMcpServer(driver,
{port, token})` → `adtLs/mcp/startMCPServer` (returns effective `{port, token}`);
`stopMcpServer(driver)` → `adtLs/mcp/stopMCPServer`; `setDestination(driver,
{destinationId})` → `adtLs/mcp/setDestination`.

- [ ] Implement the three wrappers with typed params/results.
- [ ] Add unit tests (~4 tests) using a fake driver (`sendRequest` mock):
  assert correct method strings + params are sent; result is returned verbatim.
- [ ] Run `npm test` — all tests must pass.

### Task 5: adt-ls MCP federation client

**Files:**
- Create: `src/adt-ls/mcp-federation.ts`, `tests/unit/adt-ls/mcp-federation.test.ts`

A small Streamable-HTTP MCP client to `adt-ls`'s own `/mcp` endpoint on
`http://localhost:<port>/mcp` with `Authorization: Bearer <token>`. Must do the
MCP `initialize` handshake (capture `Mcp-Session-Id`), send
`notifications/initialized`, and support `listTools()` and `callTool(name,
args)`. Parse SSE-framed responses (`data: {…}` lines). Use `undici` `fetch`.

- [ ] `AdtLsMcpClient` with `connect()`, `listTools()`, `callTool()`.
- [ ] Add unit tests (~5 tests): mock `undici` `fetch` with `mockResponse`-style
  SSE payloads; assert handshake, session header propagation, tool list parse,
  tool call, bearer header present.
- [ ] Run `npm test` — all tests must pass.

### Task 6: Minimal ARC-1-shaped MCP server + config + logger

**Files:**
- Create: `src/server/logger.ts`, `src/server/config.ts`, `src/server/server.ts`,
  `src/handlers/tools.ts`, `tests/unit/server/config.test.ts`
- Modify: `src/index.ts`

Port ARC-1's stderr logger and config-parser pattern (CLI > env > defaults).
Build an MCP server (`@modelcontextprotocol/sdk`) exposing two tools:
`health` (returns adt-ls serverInfo + MCP port/up state, no SAP needed) and
`list_destinations` (federates `abap_list_destinations` from the embedded
adt-ls MCP). On startup: discover → spawn driver → `startMcpServer` → connect
federation client. `src/index.ts` wires stdio + `http-streamable` transports
(reuse ARC-1's transport selection shape). Config adds `ARC1_ADT_LS_PATH`,
`ARC1_ADT_LS_MCP_PORT` (default e.g. 2240, distinct from VS Code's 2236),
`ARC1_TRANSPORT` (`stdio`|`http-streamable`).

- [ ] Logger writes only to stderr; never `console.log`.
- [ ] `health` tool returns `{ adtLs: { version, up }, mcpPort }`.
- [ ] `list_destinations` federates to adt-ls MCP and returns its result.
- [ ] Add unit tests (~6 tests): config precedence (CLI>env>default); tool
  registration list; `health` shape with a mocked driver/federation.
- [ ] Run `npm test` — all tests must pass.

### Task 7: End-to-end local smoke test

**Files:**
- Create: `tests/unit/foundation.smoke.test.ts`

Gated end-to-end test: discover → spawn driver → `startMcpServer` on a free
port → federation client `listTools()` returns the 14 adt-ls tools → our server
`health` reports `up:true`. Skip cleanly if no `adt-ls` binary is present.
Ensure the child process is killed in a `finally`/`afterAll`.

- [ ] Boot the full chain on a unique port; assert ≥14 federated tools and
  `health.adtLs.up === true`.
- [ ] Guarantee no orphaned `adt-ls` JVM after the test (kill in `afterAll`).
- [ ] Run `npm test` — passes (real on this machine; skipped in CI).

### Task 8: Docs

**Files:**
- Create: `README.md` (overwrite placeholder), `CLAUDE.md`
- Modify: `docs/plans/01-foundation-embedded-adt-ls.md` (this file)

- [ ] `README.md`: what arc-1-lsp is, the BYO-adt-ls model, how to point it at a
  binary (`ARC1_ADT_LS_PATH` / install the VS Code extension), run stdio/http,
  and the architecture diagram (agent → arc-1-lsp → adt-ls → SAP).
- [ ] `CLAUDE.md`: arc-1-lsp guidelines — design principles (zero hand-rolled
  ADT, BYO binary, reuse ARC-1 shell), codebase tree, key-files table, the
  adt-ls LSP API map (reference), test conventions, the 7-step roadmap.
- [ ] Run `npm run build` + `npm test` — green.

### Task 9: Final verification

- [ ] Run full test suite: `npm test` — all tests pass (smoke runs locally).
- [ ] Run typecheck: `npm run typecheck` — no errors.
- [ ] Run lint: `npm run lint` — no errors.
- [ ] Manually: `npm run build && node dist/index.js` (stdio) connects an MCP
  client and `health` + `list_destinations` work against the embedded adt-ls.
- [ ] Confirm no `adt-ls` orphan processes remain after runs.
- [ ] Move this plan to `docs/plans/completed/`.

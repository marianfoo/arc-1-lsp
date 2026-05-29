# CLAUDE.md — arc-1-lsp

Guidance for Claude Code working in this repo. Read first.

## What this is

`arc-1-lsp` is an ARC-1 edition that **delegates all ABAP/ADT work to SAP's
embedded `adt-ls`** (headless Eclipse LS from `sapse.adt-vscode`). It is the
single-developer / desktop sibling to the main multi-user/BTP ARC-1. The main
ARC-1 lives at `../arc-1`; deep background on the design and the `adt-ls`
internals is in `../arc-1/docs/research/{arc1-embedded-adt-ls-edition,sapse-adt-vscode-mcp}.md`.

## Read these first (decisions, assumptions, history)

Much of this design is shaped by *current* adt-ls limitations that SAP may lift —
so understand the **why** before changing anything:
- **`docs/adr/`** — Architecture Decision Records (the decisions + "revisit when").
  Start at `docs/adr/README.md`.
- **`docs/assumptions-and-future-changes.md`** — the watch-list: auth, PP, BTP
  setup, licensing, the private LSP protocol, TLS — what to re-verify against the
  installed adt-ls version, and what would let us delete complexity.
- **`docs/journey.md`** — the chronological story incl. dead-ends (don't re-walk them).
- **`docs/adt-ls-headless-notes.md`** — the reverse-engineered headless connection
  recipe (initialize/userAgentInfos, reentrance-ticket logon, HTTPS requirement).
- **`docs/adt-ls-tool-surface.md`** — what's reachable headless for building tools:
  the 14 federated MCP tools, the LSP method map, quickSearch's exact params, and
  the `read_source` HARD BLOCKER (readFile needs VS Code's workspace/tree model).
- **`docs/arc-1-feature-parity.md`** — arc-1 vs arc-1-lsp coverage + per-capability
  "implemented? why/why-not" (the workspace-model block gates read/test/activate/
  navigation alike). Read before adding tools, to know what's actually reachable.
- **`docs/plans/`** — ralphex plans (completed + in-progress) per roadmap state.

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
├── index.ts                 # entry (stdio | http-streamable)
├── adt-ls/
│   ├── discovery.ts         # locate adt-ls (env > vendor > installed ext; per-platform)
│   ├── driver.ts            # spawn headless + LSP over named pipe; routeServerRequest (pluggable
│   │                        #   server→client handlers) + extraEnv (JAVA_TOOL_OPTIONS truststore)
│   ├── mcp-lifecycle.ts     # adtLs/mcp/{startMCPServer,stopMCPServer,setDestination}
│   ├── mcp-federation.ts    # Streamable-HTTP client to adt-ls's own /mcp
│   ├── repository.ts        # read-only LSP queries: quickSearch (SAPSearch) + getInactiveObjects
│   ├── destinations.ts      # initializeService/create/ensureLoggedOn/getLogonInfo + headless
│   │                        #   reentrance-ticket logon handler (ADR-0006)
│   ├── tls-reverse-proxy.ts # TLS terminator: adt-ls → https://localhost → backend (direct | bridge)
│   └── cert.ts              # build the JVM truststore from adt-ls's own JRE (keytool) + openssl cert
├── btp/                     # ported from arc-1's src/adt/btp.ts (candidate shared @marianfoo/btp-connectivity)
│   ├── vcap.ts              # parseVCAPServices → BTPConfig (null off-BTP)
│   ├── token.ts             # OAuth2 client_credentials token
│   ├── connectivity.ts      # createConnectivityProxy (cached connectivity JWT)
│   ├── destination.ts       # lookupDestination (fixed-user; PP is plan 05)
│   ├── bridge.ts            # local HTTP forward proxy → BTP Connectivity (standard proxy, NOT CONNECT)
│   └── types.ts             # BTPConfig / Destination / BTPProxyConfig
└── server/
    ├── config.ts            # loadConfig (CLI > env > default); SapTargetConfig + sapDestination
    ├── logger.ts            # stderr-only logger
    ├── auth.ts              # API-key edge auth (Bearer | x-api-key)
    ├── http.ts              # http-streamable transport + API-key gate + /healthz
    ├── engine.ts            # discover→spawn→startMCP→federate; planConnection + connect (direct|CC); search/listInactive
    └── server.ts            # McpServer + read tools (health, list_destinations, list_creatable_objects,
    │                        #   search_objects, list_inactive_objects, list_users, list_generators,
    │                        #   get_generator_schema, get_object_type_details, get_service_binding)
tests/unit/…                 # vitest; adt-ls/SAP-dependent tests are skipIf-gated
docs/plans/…                 # ralphex plans (one per roadmap state)
```

## SAP connection (headless, ADR-0005/0006)

To reach a SAP backend, the engine (`planConnection` + `connect` in `engine.ts`):
1. builds TLS material from adt-ls's **own JRE** (`cert.ts`: copy cacerts + add a
   `CN=localhost` cert → truststore via `JAVA_TOOL_OPTIONS`),
2. starts the **TLS reverse proxy** (`tls-reverse-proxy.ts`) — adt-ls connects to
   `https://localhost:<port>` (trusted, hostname-matched) and it re-originates to
   the backend: **DIRECT** (internet-reachable) or **CC** (→ `bridge.ts` → BTP
   Connectivity → Cloud Connector),
3. creates a `reentranceTicket` destination + **headless reentrance logon**
   (`destinations.ts`): GET logonUrl with real creds → 307 ticket → fire-and-forget
   deliver to adt-ls's `/adt/redirect` → return `true` immediately.

`planConnection`: on BTP (connectivity bound) `ARC1_SAP_DESTINATION` → CC mode
(resolve the BTP destination); else full `ARC1_SAP_*` → DIRECT; else none.
Connection failure is **non-fatal** (server starts disconnected). Three load-bearing
facts, all live-verified: `authenticationKind:reentranceTicket` (NOT basicAuth),
`protocol:"http"` + HTTPS systemUrl, fire-and-forget delivery. Full recipe +
dead-ends: `docs/adt-ls-headless-notes.md`. `openssl` (cert gen) + `keytool` (in
adt-ls's JRE) are runtime deps — `openssl` is in the Dockerfile.

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

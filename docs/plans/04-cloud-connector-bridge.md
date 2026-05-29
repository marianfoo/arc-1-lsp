# Cloud-Connector bridge — adt-ls reaches a4h on BTP CF

## Overview

arc-1-lsp is live on CF but can't talk to SAP yet (`list_destinations` is empty).
a4h is on-premise behind a **Cloud Connector**, reachable from CF only through
the BTP **Connectivity** service proxy. adt-ls (a Java/Apache-HttpClient process)
does **not** speak BTP Connectivity natively, so arc-1-lsp must run a small
**local forward proxy** ("the bridge") that adt-ls routes through; the bridge
adds the connectivity token + Cloud-Connector headers and forwards to the BTP
connectivity proxy.

This is **not new cryptography** — arc-1 already implements the entire BTP
connectivity + destination + PP mechanism. This plan **ports arc-1's proven
logic** into arc-1-lsp and wraps it in a forward-proxy server. (The reusable
core should later become a **shared module** consumed by both editions — see
Design Principles.)

Phase A (this plan): **fixed-user** (`DEVELOPER` basic auth) via `SAP_TRIAL`.
Per-user **principal propagation** (`SAP_TRIAL_PP`) reuses the same bridge with
a per-user `Proxy-Authorization` and is plan 05.

## Context

### Current State
- arc-1-lsp live on CF (`https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com`);
  adt-ls boots; `health` ok; `list_destinations` empty (no destination bound).
- adt-ls can create destinations + log on over LSP (`adtLs/destinations/{create,
  ensureLoggedOn}`) and read source (`adtLs/fileSystem/readFile`) — not yet wired.

### arc-1 reference (read before implementing)
`../arc-1/src/adt/btp.ts` and `../arc-1/src/adt/http.ts`:

| arc-1 symbol | What it does | arc-1-lsp reuse |
|--------------|--------------|-----------------|
| `parseVCAPServices()` | reads `VCAP_SERVICES` → connectivity proxy host/port/clientid/secret/tokenUrl + destination creds | **port** to `src/btp/vcap.ts` |
| `fetchClientCredentialsToken()` | OAuth2 `client_credentials` token | **port** to `src/btp/token.ts` |
| `createConnectivityProxy()` | `{host, port, getProxyToken()}` (cached connectivity JWT) | **port** to `src/btp/connectivity.ts` |
| `lookupDestination()` / `resolveBTPDestination()` | destination config (URL, auth, ProxyType) via direct fetch | **port** to `src/btp/destination.ts` |
| `doProxyRequest()` (http.ts) | **standard HTTP-proxy protocol** (NOT CONNECT — connectivity proxy 405s on CONNECT): `GET http://target/path` + `Host` + `Proxy-Authorization: Bearer <token>` + `SAP-Connectivity-SCC-Location_ID` | **model for the bridge** (`src/btp/bridge.ts`) |
| `lookupDestinationWithUserToken()` (SAP Cloud SDK + jwt-bearer fallback) | per-user PP | **plan 05** |

Deps arc-1 uses: `@sap-cloud-sdk/connectivity`, `@sap/xsenv`, `undici@8`. Phase A
(fixed-user) only needs the lightweight custom path (no SDK); add the SDK for PP
in plan 05.

a4h is **directly reachable** at `http://a4h.marianzeis.de:50000` (user
`DEVELOPER`) — used to validate the destination/logon/read flow locally, with no
CC, before the CF bridge.

### Target State
- CF app bound to `connectivity` + `destination` services.
- On startup (when BTP-bound) arc-1-lsp starts the bridge, resolves `SAP_TRIAL`,
  creates an adt-ls destination (basic-auth `DEVELOPER`, URL = SAP_TRIAL virtual
  host) routed through the bridge, `ensureLoggedOn`, `setMcpDestination`.
- On the live CF route: `list_destinations` returns the a4h destination and a
  new `read_source` tool reads a class from a4h.

### Key Files

| File | Role |
|------|------|
| `src/btp/vcap.ts` `token.ts` `connectivity.ts` `destination.ts` | ported arc-1 BTP primitives |
| `src/btp/bridge.ts` | **NEW** local forward proxy → connectivity proxy (standard HTTP proxy) |
| `src/adt-ls/destinations.ts` | `createDestination`/`ensureLoggedOn` LSP wrappers |
| `src/server/engine.ts` | start bridge + create destination + logon when BTP-bound |
| `src/server/config.ts` | `ARC1_SAP_DESTINATION`, `ARC1_SAP_USER`, `ARC1_SAP_PASSWORD` |
| `src/handlers/tools.ts`/`server.ts` | add `read_source` tool |
| `Dockerfile` / `adt-ls.ini` | adt-ls→bridge proxy wiring (see Task 3 spike) |
| `manifest.yml` | bind `connectivity` + `destination` services |

### Design Principles
- **Reuse, don't reinvent.** Port arc-1's btp.ts logic close to verbatim;
  preserve its hard-won details (standard HTTP proxy not CONNECT; SCC-Location
  header; token caching).
- **Future shared module.** The ported `src/btp/*` is a candidate `@marianfoo/
  btp-connectivity` package (or a monorepo workspace) consumed by both arc-1 and
  arc-1-lsp. Keep it dependency-light and engine-agnostic so the extraction is
  mechanical later. Do NOT extract in this plan — just keep the seam clean.
- **Bridge = forward proxy chaining to the connectivity proxy.** adt-ls →
  localhost bridge (plain HTTP proxy) → BTP connectivity proxy (token + SCC) →
  CC → a4h. Backend basic-auth (`DEVELOPER`) is adt-ls's concern; the bridge only
  owns the proxy hop.
- **Fixed-user first, PP later** (same bridge, per-user Proxy-Authorization).
- **Secrets via env/`cf set-env`.** Never commit `DEVELOPER`'s password.
- **adt-ls-dependent tests `skipIf`-gated.**

## Development Approach

Port primitives (testable offline with mocked VCAP/fetch) → build the bridge
(testable with a mock connectivity proxy) → validate the destination/logon/read
flow locally against direct a4h → wire the bridge + adt-ls proxy routing →
bind services + deploy + verify on CF. The adt-ls→bridge routing (Task 3/4) is
the key unknown — spike it early.

## Validation Commands

- `npm run build`
- `npm test`
- `npm run typecheck`
- `npm run lint`

### Task 1: Port arc-1 BTP primitives

**Files:**
- Create: `src/btp/vcap.ts`, `src/btp/token.ts`, `src/btp/connectivity.ts`,
  `src/btp/destination.ts`, `tests/unit/btp/*.test.ts`

Port `parseVCAPServices`, `fetchClientCredentialsToken`, `createConnectivityProxy`,
`lookupDestination`/`resolveBTPDestination` from `../arc-1/src/adt/btp.ts`
(lightweight custom path; no SAP Cloud SDK yet). Keep the interfaces
(`BTPConfig`, `BTPProxyConfig`) and the token caching.

- [ ] Port the four primitives; `parseVCAPServices()` returns null off-BTP.
- [ ] Add unit tests (~8): VCAP parsing (connectivity + destination bindings),
  token fetch (mock `fetch`), proxy config shape, destination lookup (mock).
- [ ] Run `npm test`.

### Task 2: The forward-proxy bridge

**Files:**
- Create: `src/btp/bridge.ts`, `tests/unit/btp/bridge.test.ts`

`startConnectivityBridge(proxy: BTPProxyConfig)` → an `http.Server` acting as a
**plain HTTP forward proxy**: for each absolute-form request from adt-ls, re-emit
to `proxy.host:proxy.port` with `path = <absolute target URL>`, `Proxy-Authorization:
Bearer <await proxy.getProxyToken()>`, and `SAP-Connectivity-SCC-Location_ID`
when set (mirror arc-1's `doProxyRequest`, using `undici.Client`). Stream the
response back. Listens on `127.0.0.1:<ephemeral>`; returns the chosen port.

- [ ] Implement the proxy server + forwarding; expose the bound port.
- [ ] Add unit tests (~5): start a mock "connectivity proxy" http server; assert
  the bridge forwards absolute URL + `Proxy-Authorization` + SCC header, and
  relays status/body. (No SAP needed.)
- [ ] Run `npm test`.

### Task 3: adt-ls destination/logon wrappers + `read_source` tool; validate LOCALLY vs direct a4h

**Files:**
- Create: `src/adt-ls/destinations.ts`, `tests/unit/adt-ls/destinations.test.ts`
- Modify: `src/server/server.ts` (add `read_source`), `src/server/engine.ts`

Add LSP wrappers `createDestination(driver, cfg)` (`adtLs/destinations/create`)
and `ensureLoggedOn(driver, destinationId)` (`adtLs/destinations/ensureLoggedOn`);
discover the exact `create` payload shape from `../arc-1` research notes
(`docs/research/arc1-embedded-adt-ls-edition.md`) and, if needed, a captured
trace. Add a `read_source` MCP tool (via `adtLs/fileSystem/readFile` or the
federated adt-ls tools). **Gated integration test**: against direct
`http://a4h.marianzeis.de:50000` with `DEVELOPER`, create a destination, log on,
and read a known class — proving the destination/logon/read flow with no CC.

- [ ] LSP wrappers + unit tests (fake driver asserts method + payload).
- [ ] `read_source` tool registered.
- [ ] Gated local integration test (skips without `ARC1_TEST_SAP_URL`/creds):
  create → logon → read returns ABAP source.
- [ ] Run `npm test`.

### Task 4: Wire bridge + adt-ls proxy routing  ⚠ KEY UNKNOWN — spike first

**Files:**
- Modify: `src/server/engine.ts`, `src/adt-ls/driver.ts`, `Dockerfile`
- Create: `docs/adt-ls-proxy.md`

Determine how to make adt-ls (Apache HttpClient5) route a4h traffic through the
bridge. Candidates, in order: (a) JVM system props in `adt-ls.ini` `-vmargs`
(`-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=<bridge> -Dhttp.nonProxyHosts=localhost`),
if adt-ls's client honors system proxy; (b) a proxy field in the
`adtLs/destinations/create` payload; (c) `HTTP_PROXY` env. Spike each against the
running adt-ls; document the winner in `docs/adt-ls-proxy.md`. Then: when
BTP-bound, engine starts the bridge, sets the proxy for adt-ls, resolves
`SAP_TRIAL` → creates the destination (basic-auth `DEVELOPER`, virtual-host URL)
→ `ensureLoggedOn` → `setMcpDestination`.

- [ ] Spike + document the adt-ls proxy mechanism.
- [ ] Engine boots the bridge + destination + logon when BTP-bound (no-op
  locally/stdio).
- [ ] Unit-test the engine wiring with mocks (BTP-bound vs not).
- [ ] Run `npm test`.

### Task 5: Bind services + deploy + verify on CF

**Files:**
- Modify: `manifest.yml`

- [ ] `cf create-service`/`bind-service` `connectivity` (lite) + `destination`
  (lite) to `arc-1-lsp` (or add `services:` to the manifest).
- [ ] `cf set-env ARC1_SAP_DESTINATION SAP_TRIAL`, `ARC1_SAP_USER DEVELOPER`,
  `ARC1_SAP_PASSWORD <secret>`; restage.
- [ ] Verify on the live route: `list_destinations` returns the a4h destination;
  `read_source` reads a class from a4h **through the Cloud Connector**.
- [ ] `cf logs` shows the bridge forwarding + adt-ls logon success.

### Task 6: Docs + shared-module note + wrap up

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] README: BTP connectivity setup (bind services, env, the bridge).
- [ ] CLAUDE.md: `src/btp/*` provenance (ported from arc-1) + the future shared
  `@marianfoo/btp-connectivity` module seam.
- [ ] Move this plan to `docs/plans/completed/`.

### Task 7: Final verification

- [ ] `npm test` / `typecheck` / `lint` clean.
- [ ] Live CF: `list_destinations` + `read_source` work against a4h via CC.
- [ ] No adt-ls orphans; no secrets committed.
- [ ] Note plan 05 (per-user PP via `SAP_TRIAL_PP`) as next.

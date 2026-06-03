# The journey — how arc-1-lsp got here (for future Claude)

Chronological narrative of the research + build, including **what failed and
why**, so future sessions don't re-walk the dead-ends. Decisions → ADRs
(`docs/adr/`); changeable assumptions → `assumptions-and-future-changes.md`;
the headless protocol → `adt-ls-headless-notes.md`. Date: 2026-05-29.

## 0. Origin
Researched SAP's `sapse.adt-vscode` extension (teardown in main arc-1:
`docs/research/sapse-adt-vscode-mcp.md`). Discovered it bundles a **headless
Eclipse `adt-ls`** that hosts SAP's own MCP server. Idea: reuse adt-ls as ARC-1's
ADT engine → delete ARC-1's hand-rolled ADT client.

## 1. Gate: can adt-ls be driven headless? → YES (proven)
Dependency-free Node spikes spawned `adt-ls … --pipe=<socket>`, did LSP
`initialize` (~230 ms), then `adtLs/mcp/startMCPServer` → its MCP served 14
tools. No VS Code, no SAP creds. **The riskiest unknown was retired first.**

## 2. Foundation + Containerize + Deploy (Steps 1–4) → all green
- `arc-1-lsp` repo (TS/ESM, ADR-0003 shell). Driver (vscode-jsonrpc over the
  named pipe), discovery (BYO, ADR-0002), MCP federation client, minimal MCP
  server (`health`, `list_destinations`).
- **ESM trap:** vitest (esbuild) hid a `vscode-jsonrpc/node` resolution bug that
  would've broken real `node` runtime — fixed to `…/node.js`, verified with an
  actual `node` import (lesson: don't trust vitest alone for module resolution).
- Containerized: host-build dist + prod deps (pure JS) + inject linux adt-ls →
  `linux/amd64` image; only apt native deps run under emulation. Container boots
  adt-ls + full MCP chain.
- Deployed to BTP CF (ADR-0004): live at
  `arc-1-lsp.cfapps.us10-001.hana.ondemand.com`, health + MCP verified, `$PORT`
  honored, API-key gate working.

## 3. CC bridge (plan 04): studied ARC-1 first
Per the "reuse, don't reinvent" principle, read ARC-1's `src/adt/btp.ts` +
`http.ts`. **Key reused lesson:** the BTP connectivity proxy needs **standard
HTTP-proxy protocol, not CONNECT** (undici's ProxyAgent 405s). Ported the BTP
primitives to `src/btp/` and built the forward-proxy bridge.

## 4. The logon saga — many dead-ends, then the recipe (ADR-0006)
Trying to get adt-ls to actually log on to a4h. The sequence of failures was the
whole lesson:
1. `create` failed with `NoClassDefFoundError: …HttpRequestHeaderUtil`. **Root
   cause:** `UserAgentUtil.<clinit>` NPEs unless `initialize` sends
   `initializationOptions.userAgentInfos`. **Fixed in the driver — this unblocks
   ALL backend HTTP.**
2. `create` then succeeded but `ensureLoggedOn` → "Internal error". Chased it
   through stdout, `.metadata/.log`, `window/logMessage`.
3. **Dead-end — basicAuth:** assumed basic auth would work headless. It doesn't —
   adt-ls **ignores `basicAuth` for HTTP** and always does browser logon.
4. The NPE "Boolean from CompletableFuture null" → I was returning `null` to a
   server→client request. Logging all requests revealed
   `adtLs/destinations/requestBrowserBasedLogon`.
5. **Dead-end — auth-injecting gateway (premature):** pointed adt-ls at a local
   gateway with basicAuth → adt-ls made **zero** HTTP calls (failed pre-network),
   confirming the failure was internal, not the backend.
6. The real exception (from `.metadata/.log`): **`Illegal System URL http://… —
   Only HTTPS protocol is allowed`.** adt-ls requires HTTPS → use a4h:**50001**.
7. **Self-inflicted confusion:** destinations persist in the **global**
   `~/.adtls/destinations.json`; my stale `A4H` (http) entry got reused, so an
   "https" test silently used the old http URL. **Lesson: always use an isolated
   `destinationsStorePath` for tests** — and I had to clean the user's real store
   (backup `~/.adtls/destinations.json.bak-arc1`).
8. **Breakthrough:** emulate the browser headlessly — `GET` the reentrance
   `logonUrl` with `Authorization: Basic` → 307 + reentrance-ticket → deliver to
   adt-ls's `127.0.0.1/adt/redirect` listener. Ticket issued + delivered.

## 4b. The logon, finished — PROVEN connected (one more spike)
A final spike closed the last three gaps and reached `logonState:"connected"` +
real backend data (`get_all_creatable_objects` returned CLAS/OC, BDEF/BDO, …):
1. **Cert: hostname, not just trust.** A JRE truststore (copy cacerts + add a4h's
   cert) fixed *trust* but adt-ls then threw `SSLPeerUnverifiedException` — the
   cert is `*.dummy.nodomain`, not the real host, and adt-ls's **Apache** client
   ignores `-Djdk.internal.httpclient.disableHostnameVerification` (that's only for
   the JDK client). **Fix = the ADR-0005 reverse proxy:** adt-ls →
   `https://localhost:<proxy>` (cert `CN=localhost`, trusted) → re-originate to
   a4h with verification off. Same component CF needs.
2. **`authenticationKind` dead-end (again):** with `basicAuth`, logon got the
   ticket but session dispatch picked `HttpBasicAuthHandler` →
   `IllegalStateException: password must not be null` (create-time pwd not
   persisted). **Fix = `reentranceTicket`.**
3. **Delivery deadlock:** `await`ing the `/adt/redirect` delivery before returning
   `true` hangs forever (`lsof`: ESTABLISHED, no response) — the listener waits for
   the request to resolve. **Fix = fire-and-forget delivery, return `true` now.**

**Net:** headless connection is fully PROVEN, not just reverse-engineered. The
recipe is codified in `src/adt-ls/`; remaining = wiring + the read_source URI shape
+ the CF backend hop (proxy → connectivity → CC).

## 5. Verified facts worth not re-discovering
- adt-ls reachable headless; MCP startable over LSP; 14 federated tools.
- a4h: HTTP 50000 (rejected by adt-ls), HTTPS 50001 (self-signed), basic auth
  valid (`curl` 200), reentrance-ticket issues with basic auth.
- CF: `diego_docker` enabled, quota 10G, xsuaa+destination+connectivity available,
  buildx has linux/amd64.
- adt-ls launch: `adt-ls -Djco.trace_path <d> -data <d> --pipe=<unix-socket>`
  (client listens, LS connects); requires `userAgentInfos`; requires HTTPS.

## 6. Codified + connected on BTP CF (Step 4 reached)
The §4b recipe became tested modules (`src/adt-ls/{tls-reverse-proxy,cert,
destinations}.ts`, driver `routeServerRequest`+`extraEnv`, engine `planConnection`+
`connect`, `config` `SapTargetConfig`), and arc-1-lsp now **connects to a4h from
BTP CF**:
- **DIRECT mode** (plan 04 Task 5): a4h is internet-reachable, so CF connects
  straight to `a4h:50001` — no Cloud Connector needed for v1. Verified live: CF logs
  show `connected destination A4H`, and the MCP endpoint returns the real a4h
  object catalog via `list_creatable_objects`.
- **CC mode** (Task 4): coded + unit-tested (reverse proxy `forwardProxy` →
  `bridge.ts` → BTP Connectivity), **not yet deployed** (needs a running Cloud
  Connector + bound services + a BTP destination).
- Deploy lessons: `node:22-slim` lacks the `openssl` CLI (cert gen) → added to the
  Dockerfile; the connection step is non-fatal so a logon failure doesn't crash the
  server; `cf stop` before re-push when the org memory quota is tight.

## 7. The build-out — read_source solved → 39 tools (plans 05–11 + the reuse effort)
The §6 "open" items closed, then the tool surface grew. Highlights + lessons:
- **read_source / the URI lesson:** `adt://…/source/main` (double-slash ADT-path) is
  *parsed* but *rejected* by readFile/activate. The canonical **repotree/AFF URI**
  (`abap:/repotree-v1/<dest>/…/<obj>.clas.abap`, single slash) works. `search_objects
  → getLsUri{adtUri} → readFile` resolves any object by name in one hop — this unblocked
  read + the full authoring loop (create→edit→activate→test→delete in `$TMP`, live-verified).
- **Decompiled adt-ls itself** (CFR on the bundled SAP-Machine JRE) to map the WHOLE
  surface — 23 `adtLs/*` segments / ~92 methods, the advertised standard-LSP boundary,
  and the embedded MCP server's static+dynamic tool collection
  (`docs/research/adt-ls-capability-map.md`). This overturned three reverse-engineered
  verdicts and drove the reuse effort.
- **Wired 27 → 39 tools**, all live-verified end-to-end through the MCP server against
  a4h: code-intel (hover/declaration/highlight + the plan-11 set), ATC + ABAP-Unit
  coverage, run_application, service-binding details/publish, native CTS transport.
- **Three "blocked" verdicts were OUR bugs, not SAP limits:**
  - **hover / documentHighlight** returned null because the ABAP backend gates on the
    `AbapDocumentTokenCache`, primed ONLY by `textDocument/semanticTokens/full` — which
    we never sent. Prime it first → rich markdown.
  - **ATC** "no variants" was an empty-param artifact: `getCheckVariants` rejects an
    empty query; with `*`, a4h returns 15+ variants, and `runCheck("")` uses the system
    default.
  - **navigation "hangs"** was `didOpen` sent as a *request* (it's a notification).
- **Footguns found live:** `create_transport` creates a real TR even for `$TMP` (now
  guarded); the embedded-MCP port had no fallback (now retries); federated tool results
  were doubly-wrapped (now unwrapped to clean payloads, errors surfaced).

## 8. Resilience hardening — the live-test loop (2026-06-02)
With 39 tools live, a **six-round Cursor → cloud → A4H test loop** turned the surface from
"works in a demo" into "survives an unattended agent". Each round = real Cursor feedback →
fix → deploy (amd64 → ghcr → `cf push`) → live-verify. The durable lessons:

- **DX / shape fixes (commit `fba7c9e`).** `list_transports` was a token bomb — the native
  `searchTransports` returns the FULL set (**950 rows** on a4h); now capped + filterable
  (`{total,returned,truncated,…}`). Naked-value results got structured: `get_lock_status`
  always `{lockingSupported,lockId:null}`, `run_unit_tests` wraps "No tests found" → JSON,
  `assign_transport` → `{assigned,object,transport}`. `completion`/`type_hierarchy` strip
  the opaque LSP `data` blob. A `SAP_*`→`ARC1_*` env-prefix startup warning (operators
  migrating main-arc-1 configs). `list_atc_variants` needs an anchor object (documented).
- **Cold start (commit `3df0161`).** The first repository call after connect returns `[]` /
  throws `"Internal error"` for a few seconds (cold backend caches). Fix: `cold-retry.ts`
  (`withColdRetry`) retries empty-or-transient with backoff, on `search`/`resolveAffUri`/
  `listTransports`; plus a startup `warmUpBackend()`. Also: **CDS by-symbol navigation** —
  `documentSymbol` is empty for DDLS headless, so `resolvePosition` falls back to a
  word-boundary scan of the source; `type_hierarchy` `data` trimmed.
- **The dead-session discovery (commits `11df1ff`, `a0f052f`, `8ad3e6f`) — the big one.**
  After idle, EVERY call failed (`not found via search` / `Internal error`) while `health`
  said `A4H` connected. **Root cause:** the SAP session idle-expires but adt-ls signals it
  as **empty results / "Internal error"**, NOT the `"logged off"` string the existing
  self-heal watched for — so nothing re-logged on. **CF logs were decisive:** the session
  dies in **< 3 min** of idle and ONLY a re-logon revives it (a probe-retry won't). Fix
  (ADR-0008): `makeReviveIfDead` *probes* a known object → re-logon if dead (reactive on
  empty/Internal-error; proactive heartbeat). Then logs showed a plain heartbeat re-logged
  on **every ~3–4 min 24/7** even when idle (~480/day) — so it became **activity-gated**
  (only heals within 15 min of the last user call; idle servers go quiet; the next call
  self-heals). `health.backendLive` added as an honest readiness signal (the dead-probe used
  to leave it stuck `false`; a successful re-logon now sets it `true`). **Verified live
  end-to-end:** idle lapse → keep-alive silent → first call self-heals (~10 s once) → hit.
- **Lessons worth not re-discovering:** (1) a dead adt-ls session ≠ "logged off" — you MUST
  probe, not pattern-match. (2) The session lifetime is < 3 min idle and unextendable; the
  keep-alive *heals*, it can't *prevent*. (3) `health` reporting `connectedDestination` is
  NOT proof the session works — that's why `backendLive` exists. Full rationale: ADR-0008;
  capability notes: `adt-ls-reference.md` §8 list. The whole loop was **manual** — an
  automated live regression harness is the top "next" item so this can't silently regress.

## 9. Open / next
- **Rotate the `DEVELOPER` password** (security hygiene — still the shared a4h cred).
- **Automated live regression harness** — codify the six rounds' Cursor checks into a gated
  e2e suite so the hardening can't regress unseen (main arc-1 has evals; arc-1-lsp doesn't).
- **Enterprise auth Stage 2/3** (XSUAA JWT edge + per-user PP session pool) — staged;
  needs a bound XSUAA + ≥2 SAP users (plan 10 / ADR-0007). The single shared session is the
  biggest gap for multi-user. (Note: ADR-0008's liveness/keep-alive must then run per pooled
  session.)
- **CC-mode deploy** once a Cloud Connector + destination for a4h are confirmed up (only
  DIRECT mode is deployed; CC path is coded + unit-tested).
- **Publishing polish** — public ghcr image (drop pull-creds), release CI, docs page.
- Reachable-but-unwired: `completionItem/resolve`, native `activation/activate`
  (forceActivation), the `objectCreation` / `objectGenerator` LSP pipelines, `toggleVersion`.
- H01 (valid cert, OAuth reentrance) as the BTP-native target variant; ABAP Cloud / S/4
  Public Cloud, where adt-ls's "modern types only" boundary IS the native model.

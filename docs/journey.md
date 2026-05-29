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

## 7. Open / next
- **`read_source`** via LSP `adtLs/fileSystem/readFile` — the URI form
  `adt://<dest>/sap/bc/adt/oo/classes/<n>/source/main` is accepted but returned `{}`
  in the spike; nail the response shape (maybe needs stat/open first).
- **CC-mode deploy** once a Cloud Connector + destination for a4h are confirmed up.
- More curated arc-1-style tools; then per-user **principal propagation** (plan 05).
- H01 (valid cert, OAuth reentrance) as the BTP-native target variant.

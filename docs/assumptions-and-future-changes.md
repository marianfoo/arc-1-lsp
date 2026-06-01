# Assumptions & future changes — what to re-check

arc-1-lsp's design is shaped by **current limitations of SAP's `adt-ls`** (which
is young — its MCP server is flagged "experimental"). Several constraints below
may be lifted by SAP, which would let us **delete complexity**. Future Claude:
when picking this up, **re-verify the "current state" rows against the installed
adt-ls version** — if SAP changed one, simplify accordingly.

Installed reference at time of writing: `sapse.adt-vscode` **1.0.0**, adt-ls
**1.0.0.202605281240**, ADT plugins **3.58.x**, on SAP Machine JRE 21.

## 1. adt-ls authentication (the biggest lever)
- **Current:** HTTP logon is **browser-based reentrance-ticket only** — adt-ls
  ignores `basicAuth`, requires HTTPS, and drives an interactive SSO flow
  (ADR-0006). We work around it with headless browser-emulation + an
  auth-injecting proxy (ADR-0005).
- **If SAP adds** a non-interactive auth (basic/token/client-credentials) or a
  documented "headless logon" → **drop the browser-emulation and most of the
  proxy**; adt-ls could authenticate directly. **Re-check every adt-ls release.**
- **Status: IMPLEMENTED + PROVEN** (local + BTP CF). `authenticationKind` MUST be
  `reentranceTicket` (basicAuth fails session dispatch); delivery is fire-and-forget.
- **Where it lives:** `src/adt-ls/destinations.ts` (`makeReentranceLogonHandler` +
  `performReentranceLogon`), wired via `driver.setRequestHandler` in
  `src/server/engine.ts`. Recipe: `docs/adt-ls-headless-notes.md`.

## 2. Principal propagation (per-user identity)
- **Current:** adt-ls is single-session; no hook to inject a per-user token. PP is
  achieved by arc-1-lsp doing the BTP Destination-Service jwt-bearer exchange and
  injecting the per-user token at the proxy (ADR-0005), with one adt-ls session
  per concurrent user (a pool).
- **If SAP adds** native BTP Destination/PP support to adt-ls, or a way to set a
  per-request identity → PP simplifies dramatically (no pool, no proxy injection).
- **Reference:** main ARC-1's `src/adt/btp.ts` `lookupDestinationWithUserToken`
  (SAP Cloud SDK + jwt-bearer fallback); our `src/btp/*` ports the fixed-user half.
- **Status (ADR-0007 / plan 10):** designed + staged. **Stage 1 — the
  authorization scope model (`src/authz/policy.ts`) + API-key profiles + the
  `xs-security.json` descriptor — is implemented** (dep-free, unit-tested). Stage 2
  (XSUAA JWT edge → map scopes → enforce per-tool) and Stage 3 (the per-user adt-ls
  **session pool** + jwt-bearer exchange) are NOT landed — they add heavy deps
  (`@sap/xssec`, `jose`, `@sap-cloud-sdk/connectivity`) and need a bound XSUAA +
  ≥2 real SAP users to verify (currently blocked, like the CC deploy in plan 09).

## 3. BTP Connectivity / Cloud Connector
- **Current:** adt-ls doesn't speak BTP Connectivity; we run a local forward proxy
  (`src/btp/bridge.ts`) that adds the connectivity token + `SAP-Connectivity-SCC-
  Location_ID` using **standard HTTP-proxy protocol (NOT CONNECT)** — the
  hard-won lesson from ARC-1's `doProxyRequest`.
- **If SAP adds** native connectivity support to adt-ls → no bridge needed.
- **Status:** bridge implemented (`src/btp/bridge.ts`) + wired into the engine's CC
  path (`planConnection` connectivity mode → `lookupDestination` → bridge →
  reverse-proxy `forwardProxy`). **NOT yet deployed/verified end-to-end** — needs a
  running Cloud Connector + bound `connectivity`+`destination` + a BTP destination.
  v1 ships in DIRECT mode against internet-reachable a4h (no CC). The reverse
  proxy's upstream sends the destination's `URL` scheme to the bridge; the CC
  virtual host must be **HTTP** (the connectivity proxy 405s on CONNECT, so HTTPS
  virtual hosts won't tunnel) — verify this when wiring CC.
- **Setup that can change:** the bound services (`connectivity`, `destination`),
  the destination names (`SAP_TRIAL` basic/CC, `SAP_TRIAL_PP` principal-propagation),
  the CC virtual host mapping. These are admin-configured in the BTP subaccount and
  may be renamed/re-pointed — don't hard-code; read from VCAP_SERVICES + config.

## 4. adt-ls distribution & licensing (ADR-0002)
- **Current:** BYO — non-redistributable SAP Developer License; we inject the
  binary from the installed VSIX at build time.
- **If SAP** ships adt-ls standalone or allows redistribution → bundle it, drop
  the discovery/extract dance and the CI skip-gating.

## 5. adt-ls's own MCP server
- **Current:** adt-ls embeds SAP's MCP server (14 tools, `experimental`,
  disabled-by-default). We start it over LSP (`adtLs/mcp/startMCPServer`) and
  federate it. SAP may enable it by default, add tools, or change the tool set
  per backend ("IDE Actions").
- **If SAP** matures/ships this → we federate more directly; fewer custom tools
  needed. Watch the tool list per release (`docs` in main arc-1:
  `docs/research/sapse-adt-vscode-mcp.md` has the teardown).

## 6. The private LSP protocol (`adt-ls-client-protocol`)
- **Current:** **unpublished** (npm 404). We reverse-engineered the requests we
  need: `initialize{initializationOptions.userAgentInfos}`, `destinations/
  {initializeService,create,ensureLoggedOn,getLogonInfo,requestBrowserBasedLogon}`,
  `mcp/{startMCPServer,stopMCPServer,setDestination}`, `fileSystem/{readFile,…}`.
- **Risk:** SAP can change these between releases. **Pin behavior to the installed
  `sapse.adt-vscode` version**; detect + warn on mismatch.
- **If SAP publishes** the protocol/types → adopt them, drop reverse-engineering.

## 7. TLS / certificates — SOLVED by the reverse proxy (ADR-0005)
- **Current:** adt-ls requires HTTPS *and* validates the backend cert's hostname.
  A truststore alone fixes **trust** but not **hostname** (SAP's default cert is
  `CN=*.dummy.nodomain`; adt-ls's Apache client ignores
  `-Djdk.internal.httpclient.disableHostnameVerification`). **Solution:** the
  local **TLS reverse proxy** presents a `CN=localhost` cert (added to a truststore
  built from adt-ls's own JRE cacerts, so public CAs still validate) and
  re-originates to the backend with verification off (our Node code). Implemented
  in `src/adt-ls/{tls-reverse-proxy,cert}.ts`; the truststore is ephemeral
  (rebuilt per startup into a temp dir).
- **Runtime deps:** `openssl` (cert gen — in the Dockerfile) + `keytool` (ships
  with adt-ls's JRE). a4h's 1024-bit RSA cert draws a keytool warning but is
  accepted by JRE 21 (watch: a future JRE may reject 1024-bit — then a4h needs a
  fresh cert, or use a valid-cert BTP system).
- **Smoother path:** BTP ABAP systems (e.g. `H01`) have **valid CA certs**; the
  proxy could connect with verification on — but their reentrance needs OAuth, not
  basic auth (trade-off, plan 05).

## 8. Target systems (test/validation)
- **a4h** = on-prem S/4HANA 2023 trial, `https://a4h.marianzeis.de:50001`, user
  `DEVELOPER`, client 001, self-signed cert, **internet-reachable** (also via CC
  from BTP). Easiest for reentrance emulation (basic auth → ticket works). **This
  is why v1 deploys DIRECT on CF** — CF reaches a4h:50001 over the internet, no CC.
- **H01** = the user's BTP ABAP system, `https://<guid>.abap.us10.hana.ondemand.com`,
  reentranceticket, valid cert — the "native" adt-ls target, but OAuth-based.
- Credentials are **never committed**; passed via env / `cf set-env`. (The
  `DEVELOPER` password appeared in chat during research — **rotate it**.)

## 9. BTP deploy environment (can drift)
- **Current:** org `Marian Zeis_dev-9li7mzug` / space `abap-dev` on `cf
  api.cf.us10-001.hana.ondemand.com`; app `arc-1-lsp` (docker, 2G). Image
  `ghcr.io/marianfoo/arc-1-lsp:0.0.1` is **private** → CF pulls with
  `CF_DOCKER_PASSWORD=$(gh auth token)` (make the ghcr package public to drop this).
- **Org memory quota is tight** — `cf stop arc-1-lsp` before a re-push to avoid the
  transient 2×2G (old + new) that trips `memory limit exceeded`. `arc1-301-*` apps
  share the space.
- `cf push -f manifest.yml` shows a manifest diff but preserves `cf set-env` vars
  not listed in the manifest (verified). Keep secrets in `cf set-env`, not the manifest.
- **CF topology (recon 2026-06-01) — matters for CC mode:** there are TWO orgs.
  arc-1-lsp runs in `Marian Zeis_dev-9li7mzug` / `abap-dev`, whose services are
  `arc1-301-dest` (destination), `arc1-301-xsuaa`, and `abap-free` (a BTP ABAP
  env) — **no `connectivity` service**. The `connectivity` service + Cloud
  Connector live only in the OTHER org `Marian_Zeis_joule2-7lrbs13d` / `dev`
  (`arc1-connectivity` + `arc1-destination`, bound to the main arc-1 apps
  `arc1-mcp-*`). So **CC-mode deploy of arc-1-lsp first needs a `connectivity`
  instance provisioned (+ a CC→backend HTTP virtual host + a destination) in its
  space** — see `docs/cc-mode-deploy.md`. a4h being internet-reachable is why
  DIRECT mode was used and CC was never wired for arc-1-lsp.
- **Deploy needs Docker:** `cf push` uses the pre-built `ghcr` image; a new build
  (e.g. to ship new tools) needs a running Docker daemon to build `linux/amd64`
  (`scripts/docker-build.sh`) — there's no buildpack path (adt-ls + native libs).

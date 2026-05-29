# Driving adt-ls headless — protocol notes (Task 3 spike)

Findings from spiking the destination/logon flow against a real adt-ls + direct
a4h (`http://a4h.marianzeis.de:50000`). All verified 2026-05-29.

## Boot + initialize (required order)

1. Spawn `adt-ls -Djco.trace_path <dir> -data <dir> --pipe=<unix-socket>`;
   the client **listens** on the pipe, adt-ls connects.
2. LSP `initialize` **must include**:
   ```json
   { "initializationOptions": { "userAgentInfos": [{ "name": "arc-1-lsp", "version": "0.0.1" }] } }
   ```
   ⚠ **Without it, every backend HTTP call fails.** adt-ls's `UserAgentUtil`
   builds the User-Agent from `initializationOptions.userAgentInfos`; if absent,
   `LanguageClientInfo.userAgentInfos()` is null → NPE in `UserAgentUtil.<clinit>`
   → `NoClassDefFoundError: Could not initialize class …HttpRequestHeaderUtil` on
   every HTTP destination op. (Fixed in `src/adt-ls/driver.ts`.)
3. Send `initialized` notification.
4. Answer the server→client `workspace/configuration` request (return an array
   of `null`s, one per item = "use defaults"); otherwise destination init errors.

## Destinations

- Call `adtLs/destinations/initializeService` with
  `{ destinationsStorePath: "", workspaceFolderUris: [], fileUris: [] }` **before**
  any destination op (empty store path → global `~/.adtls/destinations.json`).
- `adtLs/destinations/create` payload:
  ```json
  { "id": "A4H", "protocol": "http",
    "properties": { "systemUrl": "http://a4h.marianzeis.de:50000",
                    "authenticationKind": "basicAuth", "user": "DEVELOPER",
                    "password": "…", "client": "001", "language": "EN" } }
  ```
  ✅ Succeeds once `userAgentInfos` is set. `authenticationKind` values seen in
  the destinations plugin: `basicAuth`, `reentranceTicket`, `oauth`, `sso`.
- `ensureLoggedOn` / `getLogonInfo` take the destination **id string**.

## OPEN blocker — headless basic-auth logon

`ensureLoggedOn('A4H')` returns
`{ logonState: "disconnected", message: "Internal error occurred, check the logs." }`
even though:
- a4h is reachable from here (`curl …/sap/bc/adt/discovery` → 401), and
- `DEVELOPER` basic auth is valid (`curl -u DEVELOPER:… …/discovery` → **200**).

So it is **not** network or credentials — adt-ls's *headless basic-auth logon
path* throws an internal error (a separate headless quirk from the create
blocker above). No `requestLogonInput` is sent.

## RESOLVED — the "basic-auth" framing above was wrong. Full logon recipe:

Root-caused via the Eclipse `.metadata/.log` (the stack is NOT in stdout/LSP
response; it's in `<data-dir>/.metadata/.log` and in `window/logMessage`):

1. **adt-ls ignores `authenticationKind: basicAuth` for HTTP** — it ALWAYS does
   the **browser-based reentrance-ticket** flow. (basicAuth just produced a
   confusing NPE because the logon orchestration is reentrance-only.)
2. **`systemUrl` MUST be HTTPS** — `HttpDestinationRegistry.register` throws
   `IllegalArgumentException: Illegal System URL … Only HTTPS protocol is
   allowed` for `http://`. So a4h must be `https://a4h.marianzeis.de:50001`
   (HTTP 50000 is rejected).
3. **Headless browser-emulation of the reentrance ticket WORKS** — when adt-ls
   sends the server→client request `adtLs/destinations/requestBrowserBasedLogon`
   (params[0].field.value = the `logonUrl` =
   `https://…/sap/bc/adt/core/http/reentranceticket?redirect-url=http://localhost:<adtls>/adt/redirect`):
   - GET `logonUrl` with `Authorization: Basic <DEVELOPER>` (TLS-skip for a4h's
     self-signed cert) → **307** with `location:
     http://localhost:<adtls>/adt/redirect?...&reentrance-ticket=<TICKET>`.
   - GET that `location` (use `127.0.0.1`, not `localhost`) → hits adt-ls's
     listener (returns 302) → adt-ls captures the ticket.
   - Return `true` to the request.
   (Verified: ticket issued + delivered, listener `resp 302`.)
4. **Destinations persist GLOBALLY in `~/.adtls/destinations.json`** (shared with
   the user's real VS Code/Cursor/Eclipse!). For tests, pass an **isolated**
   `destinationsStorePath` to `initializeService` — do NOT use `''` (global) or
   you pollute the user's store and stale entries get reused. (Cleaned up a
   polluting `A4H` entry; backup at `~/.adtls/destinations.json.bak-arc1`.)

### The one remaining external dependency: a4h's self-signed cert
a4h:50001 is HTTPS with a **self-signed certificate**. adt-ls's JRE will reject
it unless told to trust it. Options for the engine/container:
- Import a4h's cert into a truststore + pass `-Djavax.net.ssl.trustStore=… 
  -Djavax.net.ssl.trustStorePassword=…` to adt-ls (via adt-ls.ini `-vmargs` or
  launch args), or check for an adt-ls "trust untrusted cert" server→client
  request to answer.
- **Or target a BTP ABAP system** (e.g. the user's `H01`,
  `https://<guid>.abap.<region>.hana.ondemand.com`, **valid CA cert**) — no cert
  problem; but its reentrance ticket needs an OAuth/IAS session (not basic auth),
  so the browser-emulation would do the OAuth dance instead of basic auth.

### Implementation note
This whole recipe belongs in the engine's logon module (`src/adt-ls/` + the
`requestBrowserBasedLogon` handler in the driver), built with care + tests — not
more shell spikes. The same flow is needed on CF (behind the connectivity
bridge), where systemUrl points at the bridge over HTTPS.

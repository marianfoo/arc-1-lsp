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

### Next steps to crack it
1. Capture the adt-ls-side stack for this "Internal error" (run with the LS log
   captured, like the create-error root-causing) to find the failing class.
2. Try `reentranceTicket`/`oauth` kinds (a4h is basic, but the path may differ).
3. Fallback: write the destination directly into `~/.adtls/destinations.json`
   and let adt-ls prompt via `requestLogonInput` on first use (handle that
   server→client request with the password).
4. Whatever the fix, it is needed on CF too (same logon path behind the bridge).

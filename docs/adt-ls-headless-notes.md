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

## ✅ FULLY PROVEN end-to-end against a4h (2026-05-29)

Headless logon → `logonState: "connected"` → real backend data. Proven via a
throwaway spike (now deleted; recipe codified in `src/adt-ls/`). The complete,
working recipe — every value below is live-verified:

### 1. systemUrl must be HTTPS, and the cert problem is solved by a reverse proxy
- `HttpDestinationRegistry` rejects `http://` (*"Only HTTPS protocol is allowed"*).
- a4h:50001 presents SAP's default self-signed cert `CN=*.dummy.nodomain`. A JRE
  truststore fixes **trust** but NOT **hostname** — adt-ls's HTTP client (Apache,
  not JDK `HttpClient`, so `-Djdk.internal.httpclient.disableHostnameVerification`
  does NOT help) then throws `SSLPeerUnverifiedException: Certificate for
  <a4h.marianzeis.de> doesn't match common name of the certificate subject`.
- **Solution (ADR-0005): a local TLS-terminating reverse proxy.** adt-ls's
  `systemUrl = https://localhost:<proxyPort>`; the proxy presents a cert with
  `CN=localhost` (which we add to the JRE truststore → trust ✓ + hostname ✓) and
  re-originates to a4h:50001 with `rejectUnauthorized:false` (our Node code; we
  don't care about a4h's cert as the client). This is **the same component the CF
  bridge needs** — not a throwaway workaround. Forward `req.headers` as-is so SAP
  builds the reentrance `logonUrl` against `localhost:<proxyPort>`.

### 2. JRE truststore — copy cacerts, add the localhost (proxy) cert
Build from the bundled JRE's own cacerts (so all public CAs still work, needed
for BTP later), add the proxy's localhost cert, inject via env (launcher-agnostic,
no `-vmargs` parsing risk):
```
cp <jre>/lib/security/cacerts truststore.p12          # storepass changeit, PKCS12
<jre>/bin/keytool -importcert -keystore truststore.p12 -storepass changeit \
   -noprompt -alias arc1-proxy-localhost -file proxy-cert.pem
# spawn adt-ls with:
JAVA_TOOL_OPTIONS="-Djavax.net.ssl.trustStore=<p12> -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12"
```
(`keytool`/`java` live in `…/com.sap.adt.jvm.sapmachineminimal.*/jre/bin/`.)

### 3. create — `protocol:"http"`, `authenticationKind:"reentranceTicket"`
```json
{ "id": "A4H", "protocol": "http",
  "properties": { "systemUrl": "https://localhost:<proxyPort>",
                  "authenticationKind": "reentranceTicket",
                  "user": "DEVELOPER", "client": "001", "language": "EN" } }
```
- `protocol:"http"` = ADT-over-HTTP (vs RFC); the **URL scheme lives in
  systemUrl**. `protocol:"https"` → `Protocol.ordinal() because "protocol" is null`.
- **`authenticationKind` MUST be `"reentranceTicket"`, NOT `"basicAuth"`.** With
  `basicAuth`, logon does the reentrance dance to get a ticket but then session
  dispatch picks `HttpBasicAuthHandler` → `IllegalStateException: The password
  must not be null or empty` (adt-ls does NOT persist the create-time password).
  `reentranceTicket` makes the session use the delivered ticket → connected.
- `create` returns the destination id string on success (e.g. `"A4H"`).

### 4. ensureLoggedOn → requestBrowserBasedLogon → headless reentrance emulation
`ensureLoggedOn('A4H')` (param = bare id string) makes adt-ls send the
server→client request `adtLs/destinations/requestBrowserBasedLogon` with:
```json
{ "id":"A4H","title":"Logon to A4H",
  "params":[{"field":{"key":"logonUrl","value":"https://localhost:<proxy>/sap/bc/adt/core/http/reentranceticket?redirect-url=http%3A%2F%2Flocalhost%3A<adtls>%2Fadt%2Fredirect&_=…"}}]}
```
Handler:
1. `GET logonUrl` with `Authorization: Basic <user:pass>` → **307**, `location:
   http://localhost:<adtls>/adt/redirect?...&reentrance-ticket=<TICKET>`.
2. **Fire-and-forget** `GET location` (rewrite `localhost`→`127.0.0.1`) → adt-ls
   listener returns **302**. ⚠ **Do NOT `await` this before returning** — adt-ls's
   `/adt/redirect` listener won't respond until the `requestBrowserBasedLogon`
   request resolves `true` (browser-flow semantics: `true` = "browser opened").
   Awaiting the delivery deadlocks (proven via `lsof`: ESTABLISHED, no response).
3. **Return `true` immediately.**

adt-ls then emits `adtLs/destinations/logonStateChanged` → `pending` → `connected`,
and `ensureLoggedOn` resolves `{ logonState: "connected" }`.

### 5. Other server→client requests during logon (must answer correctly)
- `workspace/configuration {items:[…]}` → return `items.map(()=>null)` (use
  defaults; one was `adt.joule.url`). A bare `null` is wrong (it wants an array).
- `client/registerCapability`, `window/workDoneProgress/create` → `null` is fine.

### 6. Destinations persist GLOBALLY in `~/.adtls/destinations.json`
Shared with the user's real VS Code/Cursor/Eclipse! Always pass an **isolated**
`destinationsStorePath` to `initializeService` (NOT `''` = global) so tests/runs
never pollute the user's store or reuse stale entries.

### 7. Backend calls + read_source
- Federated MCP backend calls work once connected, e.g.
  `abap_creation-get_all_creatable_objects {destination:"A4H"}` returned real
  rows (`{"creatableObjects":[{"name":"ABAP Class","objectType":"CLAS/OC"},…]}`).
- **adt-ls's MCP has NO read-source/search tool** (the 14 tools are creation /
  activation / unit-tests / transport / generators / business-services). So
  `read_source` (SAPRead) MUST use LSP `adtLs/fileSystem/readFile`. The URI form
  `adt://<DEST>/sap/bc/adt/oo/classes/<name>/source/main` is accepted; the exact
  response shape still needs nailing during implementation (a bare `{}` came back
  — likely needs a stat/open first or a different result field).

### MCP start quirk
`adtLs/mcp/startMCPServer` rejects `port:0` (*"Port must be between 1024 and
65535"*) — pass an explicit fixed port.

### Remaining for CF (not local)
Local a4h is fully solved. On CF the **same reverse proxy** terminates TLS for
adt-ls; its backend side forwards through the **BTP connectivity forward-proxy**
(`src/btp/bridge.ts`) → Cloud Connector → a4h, instead of connecting to a4h
directly. BTP ABAP systems (valid CA cert) need no localhost-proxy cert trick but
use OAuth (not Basic) when fetching the reentrance ticket.

# ADR-0006: Headless logon by emulating the reentrance-ticket browser flow

## Status
Accepted (2026-05-29) — **PROVEN end-to-end against a4h (`logonState:"connected"` +
real backend data)**; full recipe in `docs/adt-ls-headless-notes.md` ("FULLY PROVEN").

## Context
To use adt-ls headlessly we must get it from "destination created" to "logged on"
without a human or browser. Live testing against a4h revealed adt-ls's actual
HTTP logon behavior (this is the crux of the whole project):
- adt-ls **ignores `authenticationKind: basicAuth` for HTTP** and **always** runs
  the **browser-based reentrance-ticket** flow.
- It **requires HTTPS** (`HttpDestinationRegistry`: *"Only HTTPS protocol is
  allowed"*) — `http://` system URLs are rejected.
- It needs `initializationOptions.userAgentInfos` in LSP `initialize`, or every
  HTTP call NPEs in `UserAgentUtil.<clinit>` (fixed in the driver).

## Decision
**Emulate the browser headlessly.** When adt-ls sends the server→client request
`adtLs/destinations/requestBrowserBasedLogon` (carrying `logonUrl =
…/sap/bc/adt/core/http/reentranceticket?redirect-url=http://localhost:<adtls>/adt/redirect`):
1. `GET logonUrl` with the real credentials (`Authorization: Basic <user>` for a4h;
   OAuth bearer for BTP) → SAP returns **307** with `location:
   http://localhost:<adtls>/adt/redirect?...&reentrance-ticket=<TICKET>`.
2. **Fire-and-forget** `GET location` (rewrite `localhost`→`127.0.0.1`) → delivers
   the ticket to adt-ls's local listener (returns 302) → adt-ls captures it.
3. **Return `true` immediately** — do NOT await step 2. adt-ls's `/adt/redirect`
   listener won't respond until this request resolves `true` ("browser opened"),
   so awaiting the delivery **deadlocks** (proven via `lsof`).

Two create-payload requirements make this work (both proven):
- **`authenticationKind: "reentranceTicket"`** (NOT `basicAuth`) — basicAuth gets a
  ticket but session dispatch then needs a password it never persisted
  (`IllegalStateException: password must not be null`). The Basic creds are applied
  by OUR handler in step 1, not stored on the destination.
- **`protocol: "http"`** with **HTTPS** `systemUrl` (scheme lives in the URL).

The self-signed-cert problem is solved by the **ADR-0005 local reverse proxy**, not
a truststore-only hack: a JRE truststore fixes *trust* but not *hostname*
(`*.dummy.nodomain` ≠ real host; adt-ls's Apache client ignores
`-Djdk.internal.httpclient.disableHostnameVerification`). So `systemUrl` points at
`https://localhost:<proxy>` with a `CN=localhost` cert in the truststore.

## Consequences
- Headless logon works without a browser — **proven to `logonState:"connected"`
  with real backend data returned** (not just ticket issuance).
- arc-1-lsp's logon handler is where real credentials are applied → ties directly
  into ADR-0005 (the reverse proxy also terminates TLS for the localhost cert).
- Coupled to SAP's reentrance-ticket URL shape + adt-ls's request contract
  (private; pin to the installed version).
- The reverse proxy is the single component solving cert trust+hostname AND (on
  CF) the Cloud-Connector hop — one mechanism, reused.

## Revisit when
- adt-ls adds a **headless / basic / token logon mode** (no browser) → drop the
  emulation entirely. (Worth re-checking each adt-ls release — the MCP server &
  this flow are young/"experimental".)

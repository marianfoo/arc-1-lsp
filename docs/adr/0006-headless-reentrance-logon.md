# ADR-0006: Headless logon by emulating the reentrance-ticket browser flow

## Status
Accepted (2026-05-29) — based on live reverse-engineering; see `docs/adt-ls-headless-notes.md`

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
`adtLs/destinations/requestBrowserBasedLogon` (carrying the `logonUrl =
…/sap/bc/adt/core/http/reentranceticket?redirect-url=http://localhost:<adtls>/adt/redirect`):
1. `GET logonUrl` with the real credentials (`Authorization: Basic <user>` for a4h;
   OAuth bearer for BTP) → SAP returns **307** with `location:
   http://localhost:<adtls>/adt/redirect?...&reentrance-ticket=<TICKET>`.
2. `GET` that `location` (use `127.0.0.1`) → delivers the ticket to adt-ls's local
   listener (returns 302) → adt-ls captures it and completes logon.
3. Return `true` to the request.

`systemUrl` is HTTPS. Self-signed certs (a4h:50001) require the JRE to trust them
(truststore via `-Djavax.net.ssl.trustStore`, or a valid-cert BTP system avoids it).

## Consequences
- Headless logon works without a browser — proven through ticket issuance +
  delivery (listener `resp 302`).
- arc-1-lsp's logon handler becomes the place real credentials are applied → ties
  directly into ADR-0005 (the proxy can serve the reentrance endpoint locally and
  do the real auth).
- Coupled to SAP's reentrance-ticket URL shape + adt-ls's request contract
  (private; pin to the installed version).
- Self-signed certs need explicit trust; valid-cert (BTP) systems are smoother.

## Revisit when
- adt-ls adds a **headless / basic / token logon mode** (no browser) → drop the
  emulation entirely. (Worth re-checking each adt-ls release — the MCP server &
  this flow are young/"experimental".)

# ADR-0005: arc-1-lsp owns authentication via a local injecting proxy

## Status
Accepted (2026-05-29) — central architectural decision

## Context
For arc-1-lsp to reach SAP **headlessly** (on CF, no human, no browser), the SAP
auth must be **non-interactive**. But (see ADR-0006) adt-ls's own auth is
interactive (SSO/reentrance/browser) and it doesn't speak BTP Connectivity
natively. Two related problems:
1. **Reachability:** on-prem systems sit behind a **Cloud Connector**, reachable
   from CF only via the BTP Connectivity proxy (token + `SAP-Connectivity-SCC-
   Location_ID` header, **standard HTTP-proxy protocol, NOT CONNECT**). adt-ls
   can't do this.
2. **Identity:** per-user **principal propagation** requires a per-user token; adt-ls
   has no hook to inject one.

## Decision
**arc-1-lsp owns authentication and connectivity; adt-ls only ever talks to a
local endpoint.** A local **proxy/gateway** (`src/btp/bridge.ts` for the CC hop;
a logon/auth-injecting layer for credentials) sits between adt-ls and SAP:
- adt-ls's destination `systemUrl` points at the local proxy.
- The proxy adds the real backend auth (basic for a4h, OAuth/bearer for BTP,
  per-user PP token for multi-user) and the BTP Connectivity headers, then forwards
  to the real system.
- adt-ls authenticates only to the local proxy (trivially), so its interactive-auth
  limitation never reaches the real SAP system.

This is the *same* component for: CC reachability, fixed-user basic auth, and
later per-user PP — only the injected credential differs.

## Consequences
- Decouples adt-ls from the auth problem entirely → headless + per-user PP become
  possible.
- arc-1-lsp must faithfully proxy ADT semantics (CSRF, cookies, the reentrance-ticket
  redirect — see ADR-0006) through the local endpoint.
- Reuses ARC-1's proven Destination/Connectivity logic (ADR-0003) for the
  injected side.
- One JVM + proxy per concurrent identity (adt-ls is single-session) → bounded
  multi-user via a pool; not mass-scale.

## Revisit when
- adt-ls gains a **native non-interactive/token auth** or **native BTP Destination/
  Connectivity** support → the proxy could shrink or disappear.

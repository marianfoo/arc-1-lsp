# ADR-0007: Enterprise auth — a scope model, XSUAA edge, and per-user PP via a session pool

## Status
Proposed (2026-06-01). **Stage 1 (the scope/authorization model) is implemented;**
the XSUAA JWT edge and per-user Principal Propagation are designed here and staged
(see `docs/plans/10-enterprise-auth.md`) — both need a bound XSUAA service +
multi-user SAP to verify, which isn't available yet.

## Context
arc-1-lsp today authenticates the HTTP edge with **flat API keys** (any valid key
= full access) and runs every SAP operation as **one shared technical user** (the
startup-connected destination). That contradicts two ARC-1 design principles:
**per-user SAP identity** and **centralized admin control with per-user scopes**.

The main ARC-1 already solves this, but at a cost arc-1-lsp shouldn't adopt
wholesale in one step:
- `src/server/xsuaa.ts` is ~528 lines (XSUAA JWT validation via `@sap/xssec`, an
  MCP OAuth proxy provider, Dynamic Client Registration with a stateless signed
  client store) + a scope model in `src/authz/policy.ts`.
- PP (`lookupDestinationWithUserToken`) uses `@sap-cloud-sdk/connectivity` + a
  jwt-bearer token exchange.
- Together that's **4 heavy dependencies** (`@sap/xssec`, `@sap/xsenv`,
  `@sap-cloud-sdk/connectivity`, `jose`) added to a currently 4-dependency project,
  plus a **major architectural change**: adt-ls holds **one** logged-on session per
  destination, so per-user identity means **N concurrent adt-ls sessions** (a pool),
  not one.

None of the JWT/PP/pool behavior can be verified without a bound XSUAA instance and
≥2 real SAP users — currently blocked.

## Decision
Adopt the layered model, **staged**, smallest-verifiable-first:

1. **Authorization scope model (Stage 1 — implemented).** A dependency-free
   `src/authz/policy.ts`: scopes `read ⊂ write ⊂ transport`, plus `admin ⊇ all`;
   a `TOOL_SCOPES` map (every tool → its required scope, `null` = always-allowed
   like `health`); and named **profiles** (`viewer`/`developer`/`admin`) → scope
   sets. This is the single thing BOTH the API-key edge and a future XSUAA JWT feed
   into. Pure, unit-tested, no new deps. API keys gain an optional `key:profile`.

2. **XSUAA OAuth edge (Stage 2 — staged).** Validate XSUAA JWTs in the HTTP chain
   (after API-key), mapping JWT scopes → the Stage-1 scope set; enforce per-tool via
   `TOOL_SCOPES`, threading the authenticated scopes into tool handlers as MCP
   `AuthInfo`. Ship `xs-security.json` (the descriptor) now so the role/scope set is
   reviewable and bind-ready. Port arc-1's `xsuaa.ts` + DCR store; adds `@sap/xssec`
   + `jose` (+ `@sap/xsenv`).

3. **Per-user PP via a session pool (Stage 3 — staged).** Per request, exchange the
   user JWT for a destination token (jwt-bearer, port `lookupDestinationWithUserToken`)
   and route through a **pool of adt-ls sessions keyed by user** — one logged-on
   destination per user — instead of the single shared session. Adds
   `@sap-cloud-sdk/connectivity` and the pool lifecycle (creation, idle eviction,
   the per-user reverse-proxy/bridge identity injection from ADR-0005). This is the
   big architectural change and the one most needing live multi-user verification.

The scope model + `xs-security.json` ship first because they're safe, useful
(per-key profiles are real multi-client governance), dependency-free where possible,
and the foundation the heavier stages consume.

## Consequences
- arc-1-lsp gains a real authorization model immediately (per-key profiles), and a
  clear, reviewed path to OAuth SSO + per-user SAP identity.
- The scope model deliberately ships slightly ahead of its enforcement wiring
  (Stage 2 threads it into handlers) — it's tested in isolation, not dead-ended.
- Stages 2–3 add heavy deps + a concurrency architecture (the pool) and **must be
  verified live** (bound XSUAA + ≥2 SAP users) before merge — they are explicitly
  not landed unverified.
- The scope set is kept small (`read`/`write`/`transport`/`admin`) — no `sql`/`data`/
  `git` (adt-ls has no such surface), so it stays simpler than arc-1's 7-scope model.

## Revisit when
- adt-ls gains **native per-request identity / BTP destination support** → PP loses
  the pool + proxy injection (assumptions §2); revisit Stage 3 entirely.
- SAP matures adt-ls's MCP auth → some edge work may move into adt-ls.

# Plan 10 — Enterprise auth (scope model → XSUAA edge → per-user PP)

Architecture + rationale: [ADR-0007](../adr/0007-enterprise-auth-scopes-xsuaa-pp.md).
Staged smallest-verifiable-first; only Stage 1 lands this session (Stages 2–3 need
a bound XSUAA + multi-user SAP to verify — blocked).

## Stage 1 — Authorization scope model (THIS session; dep-free, unit-tested)

- **`src/authz/policy.ts`** (new): `Scope` (`read`/`write`/`transport`/`admin`);
  `expandScopes(granted)` (admin ⊇ all; transport ⊇ write ⊇ read); `TOOL_SCOPES`
  (every tool → required scope, `null` = always-allowed like `health`);
  `PROFILES` (`viewer`→[read], `developer`→[read,write], `admin`→[admin]);
  `scopesForProfile(name)`; `hasToolAccess(grantedScopes, toolName)`.
- **`src/server/auth.ts`**: API keys gain an optional `key:profile` (default
  `developer` for back-compat with bare keys — preserves today's "any key = write"
  unless an admin assigns `viewer`). Expose the resolved scopes on the parsed key.
- **`xs-security.json`** (new): the XSUAA descriptor — `xsappname`, `scopes`
  (`$XSAPPNAME.read|write|transport|admin`), `role-templates`
  (Viewer/Developer/Admin), `oauth2-configuration`. Reviewable + bind-ready; not
  wired until Stage 2.
- Tests: `tests/unit/authz/policy.test.ts` (expand hierarchy; TOOL_SCOPES covers
  all 21 tools incl. `null` for health; profile→scopes; hasToolAccess matrix) +
  `auth.test.ts` (key:profile parsing, bare-key default).
- **Not in Stage 1:** enforcement wiring into tool handlers (needs MCP `AuthInfo`
  threading — Stage 2, where the JWT path populates it). The model is tested in
  isolation; `TOOL_SCOPES` completeness is guarded by a test that every registered
  tool has an entry.

## Stage 2 — XSUAA OAuth edge (staged; needs bound XSUAA to verify)

- Port arc-1 `src/server/xsuaa.ts` (XsuaaService JWT validation) + the stateless
  DCR client store; add `@sap/xssec` + `jose` (+ `@sap/xsenv`).
- HTTP chain: XSUAA JWT → (existing) API-key. Map JWT scopes → Stage-1 `Scope`s;
  populate MCP `AuthInfo`; enforce `hasToolAccess` per tool call.
- Bind via `xs-security.json`; verify with a real XSUAA + an MCP OAuth client.
- Unit-testable with a mock JWKS/token; **live-verify before merge.**

## Stage 3 — Per-user PP via an adt-ls session pool (staged; needs ≥2 SAP users)

- Port `lookupDestinationWithUserToken` (jwt-bearer exchange; adds
  `@sap-cloud-sdk/connectivity`).
- Replace the single shared session with a **pool keyed by user**: one adt-ls
  logged-on destination per user (creation, idle eviction), per-user identity
  injected at the reverse-proxy/bridge (ADR-0005). The crux: adt-ls is single-session.
- **Live-verify with ≥2 distinct SAP users before merge** (SAP-side auth applies
  per user; arc-1-lsp scopes are defense-in-depth).

## Validation
- Stage 1: `build`/`typecheck`/`lint`/`test` green; policy fully unit-tested.
- Stages 2–3: unit tests now; **live verification is a hard gate** (bound XSUAA +
  multi-user SAP — currently blocked, same as the CC deploy in plan 09).

# ADR-0008: Session resilience — liveness-probe heal + activity-gated keep-alive

## Status
Accepted (2026-06-02). Implemented + verified live on CF → A4H. Builds on ADR-0006
(headless reentrance logon) and the self-heal in `session-retry.ts`.

## Context
adt-ls holds **one** SAP security session per destination after the reentrance-ticket
logon (ADR-0006). On the live a4h deployment that session turned out to be **short-lived
and fragile**, surfacing three distinct failure modes that a real Cursor test loop
exposed (see `docs/journey.md` §8):

1. **Cold start.** On a fresh connect (and after idle) the backend caches are cold: the
   first repository `quickSearch` returns `[]` and `cts/transport/searchTransports`
   throws a generic `"Internal error"` for several seconds until warm. The first
   `hover`/`search`/`read_source`/`list_transports` therefore false-negatived.
2. **Silent death.** The session **idle-expires in < 3 min**, and adt-ls does **not**
   emit the `"Your user was logged off"` string that the existing `withRelogon`
   self-heal (`session-retry.ts`) watches for. Instead repository searches come back
   **empty** and CTS throws **`"Internal error"`** — indistinguishable from a normal
   no-match at the result level. So `withRelogon` never fired, and a naïve retry just
   retried a dead session forever. Live logs confirmed it: every probe ~4 min apart
   found the session dead.
3. **False-healthy health.** `health.connectedDestination` stayed `"A4H"` (the
   destination *metadata* is intact) while every data call failed — agents had no
   signal to distinguish a live session from a connected-but-dead one.

Constraints from ADR-0003 (pure adt-ls, no direct ADT) and the single-session model:
the only cure for a dead session is a **full re-logon** (`ensureLoggedOn` re-fires the
registered reentrance handler — there is no `logoff`/refresh method, and a search-retry
does not revive it). The keep-alive can therefore only *heal* the session, not *prevent*
its death.

## Decision
A three-layer resilience model in `src/adt-ls/cold-retry.ts` + `session-retry.ts` +
`server/engine.ts`:

1. **Cold-retry (`cold-retry.ts`, `withColdRetry`).** A bounded linear-backoff retry
   that retries a *cold result* (empty references) **or** a *transient throw*
   (`isTransientColdError` — `"Internal error"`). Wired into `quickSearch({cold:true})`
   (→ `engine.search`, `lifecycle.resolveAffUri`) and `lifecycle.listTransports`. It
   never hides a genuine outcome — after the attempts it returns/throws the real result.

2. **Liveness-probe heal (`session-retry.ts`, `makeReviveIfDead`).** Because a dead
   session looks like an empty result, detection must **probe**, not pattern-match:
   probe a known-present object (`CL_ABAP_TYPEDESCR`); an empty/failed probe ⇒ the
   session is dead ⇒ force a re-logon; return `true` iff it re-logged on (caller
   retries). Wired **reactively** — `engine.search` / `resolveAffUri` on a persistent
   empty, `listTransports` on a persistent `"Internal error"` — and **proactively** as
   the keep-alive heartbeat.

3. **Activity-gated keep-alive (`engine.ts`).** A 3-min heartbeat that probes + heals,
   but **only within `KEEPALIVE_ACTIVITY_WINDOW_MS` (15 min) of the last *user* call**.
   Because the session can't be kept alive (it dies < 3 min regardless), an always-on
   heartbeat would re-logon 24/7 on an idle server (~480/day — audit-log noise + load).
   Gating it on usage keeps an active session warm (fast calls) and lets an idle server
   go quiet; the next user call after a lapse self-heals via layer 2. The heartbeat's own
   probe uses the **raw driver** (not the activity-marking `sessionRequester`) so it
   doesn't perpetuate its own window.

Plus a **`health.backendLive`** field: last-known real-round-trip liveness (set `true` on
any successful search/re-logon, refreshed by the heartbeat + a one-shot probe after
warm-up), so agents have an honest readiness signal distinct from `connectedDestination`.
It is *last-known*, not a per-call probe — `health` itself does not round-trip the backend.

## Consequences
**Good**
- Unattended agents work: cold start, idle death, and the connected-but-dead state all
  self-heal; no manual warm-up/retry needed. Verified live end-to-end (idle lapse →
  first call self-heals → hit).
- No 24/7 re-logon churn on an idle server.
- `backendLive` gives a real readiness signal.

**Bad / accepted trade-offs**
- The **first call after a > 15-min idle pays a one-time ~7–10 s** self-heal (re-logon),
  then warm again. This is the deliberate cost of zero idle churn (the user chose it over
  "always warm").
- `backendLive` is last-known (≤ 3 min stale during active use), not a live per-call
  probe — making `health` round-trip on every call was rejected to keep it cheap.
- A genuinely-absent object now costs a bounded extra delay (cold-retry attempts) before
  "not found", and an empty search triggers one liveness probe.
- `KEEPALIVE_INTERVAL_MS` (3 min) / `KEEPALIVE_ACTIVITY_WINDOW_MS` (15 min) are the only
  tuning knobs; if the session lifetime changes they may need adjusting.

## Revisit when
- adt-ls exposes a **session-status / refresh** API, or a **non-interactive token**
  logon whose session lives longer (or can be cheaply refreshed without a full
  reentrance flow) → the probe + re-logon churn collapses to a token refresh.
- The single-session model becomes a **per-user session pool** (ADR-0007 Stage 3) — the
  liveness/keep-alive logic must then run per pooled session.
- The backend session timeout is raised well above the keep-alive window → the activity
  gating can relax (or the keep-alive could actually *prevent* death, not just heal it).

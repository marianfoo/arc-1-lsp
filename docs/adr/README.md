# Architecture Decision Records — arc-1-lsp

Each ADR captures **one decision**, the **context** that forced it, and — crucially
for this project — **what could change in the future to make it obsolete or
easier**. Much of arc-1-lsp's design is shaped by *current limitations of SAP's
`adt-ls`* that SAP may lift; when they do, several of these decisions should be
revisited (see each ADR's "Revisit when" + [`../assumptions-and-future-changes.md`](../assumptions-and-future-changes.md)).

Read [`../journey.md`](../journey.md) for the chronological story (what we tried,
what failed, why) behind these decisions.

| ADR | Decision | Revisit trigger |
|-----|----------|-----------------|
| [0001](0001-separate-embedded-edition.md) | arc-1-lsp is a **separate edition**, not a change to main arc-1 | adt-ls becomes multi-user / lightweight |
| [0002](0002-byo-adt-ls-no-redistribution.md) | **BYO adt-ls** — never bundle/redistribute the SAP binary | SAP licenses adt-ls for redistribution / ships it standalone |
| [0003](0003-adt-ls-as-engine.md) | adt-ls is **the ADT engine**; reuse arc-1's shell; port BTP primitives | the LSP/MCP contract stabilizes & is published |
| [0004](0004-container-cf-apikey.md) | **Docker image on CF**, API-key edge auth for v1 | XSUAA needed; non-CF target |
| [0005](0005-auth-injecting-proxy.md) | **arc-1-lsp owns auth** via a local injecting proxy; adt-ls talks to localhost | adt-ls gains non-interactive / token / native-BTP auth |
| [0006](0006-headless-reentrance-logon.md) | Headless logon by **emulating the reentrance-ticket browser flow**; HTTPS required | adt-ls adds a headless/basic/token logon mode |
| [0007](0007-enterprise-auth-scopes-xsuaa-pp.md) | **Enterprise auth**, staged: scope model (done) → XSUAA edge → per-user PP session pool | a bound XSUAA + ≥2 SAP users to verify Stages 2–3 |
| [0008](0008-session-resilience-liveness-keepalive.md) | **Session resilience** — liveness-probe heal + activity-gated keep-alive (a dead session = empty results, not "logged off") | adt-ls exposes session-status/refresh or a longer-lived token logon |

## Format

```
# ADR-NNNN: <title>
## Status      Accepted | Superseded by ADR-XXXX | Proposed   (date)
## Context     the forces / constraints
## Decision    what we chose
## Consequences  what follows (good + bad)
## Revisit when  the future change that would flip this
```

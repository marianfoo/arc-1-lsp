# ADR-0003: adt-ls is the engine; reuse ARC-1's shell; port BTP primitives

## Status
Accepted (2026-05-29)

## Context
The whole point of arc-1-lsp is to **stop reimplementing ADT** (HTTP/CSRF/lock/
XML/object-type quirks) and let SAP's battle-tested `adt-ls` do it. But arc-1-lsp
still needs an MCP front-end, auth, scopes, logging, and (on BTP) the Destination/
Connectivity machinery — all of which **main ARC-1 already has**.

## Decision
- **Zero hand-rolled ADT — a HARD LINE, no hybrid (confirmed 2026-05-29).** Do NOT
  port `src/adt/{http,crud,xml-parser,…}` from ARC-1, and do NOT make direct HTTP
  ADT calls (no `GET /sap/bc/adt/…`), **even when it's trivially easy and an adt-ls
  path is flaky or missing.** ALL ADT/SAP interaction goes through adt-ls — via its
  **MCP endpoint** (federation, stable/public) and its **LSP** (`fileSystem/{readFile,
  writeFile,delete}`, `activation/activate`, etc., rich but private). The local
  reverse proxy / connectivity bridge carries adt-ls's *own* traffic only; arc-1-lsp
  never originates ADT requests through it.
- **adt-ls's headless capability IS arc-1-lsp's product boundary.** If adt-ls can't
  do something headless, arc-1-lsp doesn't do it — the capability is **out of scope
  for this edition and belongs to main ARC-1** (the full ADT-API client). Concretely:
  the `read_source`-by-name "direct ADT GET" shortcut (option B in
  `docs/read-source-evaluation.md`) is **REJECTED** — by-name source reads either go
  through a pure adt-ls resolver or are an arc-1 feature, not a hybrid here.
- **Gaps are a feature of the comparison, not a bug.** arc-1-lsp won't be "perfect";
  what it *can't* reach is an honest, evidence-backed map of where adt-ls falls short
  headless (kept in `docs/arc-1-feature-parity.md`). That map is itself a deliverable.
- **Reuse ARC-1's shell**: MCP server shape, stderr logger, config-precedence,
  auth/scope conventions, Zod schemas — adapt, don't reinvent.
- **Port ARC-1's BTP primitives** (`parseVCAPServices`, client-creds token,
  connectivity proxy, destination lookup, the standard-HTTP-proxy `doProxyRequest`
  lesson) into `src/btp/` — kept dependency-light + engine-agnostic. (Connectivity/
  auth plumbing is not "ADT" — it's how adt-ls *reaches* SAP — so it's in-bounds.)

## Consequences
- Big code deletion vs main ARC-1 (no ADT client).
- Coupling to adt-ls's contracts: the **MCP** surface is stable/public; the **LSP**
  custom protocol (`adt-ls-client-protocol`) is **private and unpublished** (npm
  404) → reverse-engineered, version-pin to the installed extension, expect churn.
- `src/btp/*` is a near-duplicate of ARC-1's btp.ts → a **future shared module**
  (`@marianfoo/btp-connectivity`) consumed by both editions. Keep the seam clean;
  do NOT extract prematurely.

## Revisit when
- SAP **publishes/stabilizes** the adt-ls LSP client protocol → less brittleness,
  safe to lean on the LSP channel for everything.
- The shared `@marianfoo/btp-connectivity` module is worth extracting (both editions
  drift in sync often enough).
- The "no hybrid" line is intentionally strict; the **only** condition that should
  reopen it is if SAP officially blesses a direct-ADT escape hatch *or* the editions
  are deliberately merged. Convenience or a flaky adt-ls path is NOT a reason —
  route those users to main ARC-1 instead.

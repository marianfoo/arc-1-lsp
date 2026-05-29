# ADR-0003: adt-ls is the engine; reuse ARC-1's shell; port BTP primitives

## Status
Accepted (2026-05-29)

## Context
The whole point of arc-1-lsp is to **stop reimplementing ADT** (HTTP/CSRF/lock/
XML/object-type quirks) and let SAP's battle-tested `adt-ls` do it. But arc-1-lsp
still needs an MCP front-end, auth, scopes, logging, and (on BTP) the Destination/
Connectivity machinery — all of which **main ARC-1 already has**.

## Decision
- **Zero hand-rolled ADT.** Do NOT port `src/adt/{http,crud,xml-parser,…}` from
  ARC-1. All ADT/SAP interaction goes through adt-ls — via its **MCP endpoint**
  (federation, stable/public) and its **LSP** (`fileSystem/readFile`, `activation/
  activate`, etc., rich but private).
- **Reuse ARC-1's shell**: MCP server shape, stderr logger, config-precedence,
  auth/scope conventions, Zod schemas — adapt, don't reinvent.
- **Port ARC-1's BTP primitives** (`parseVCAPServices`, client-creds token,
  connectivity proxy, destination lookup, the standard-HTTP-proxy `doProxyRequest`
  lesson) into `src/btp/` — kept dependency-light + engine-agnostic.

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

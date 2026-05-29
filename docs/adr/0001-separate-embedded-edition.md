# ADR-0001: arc-1-lsp is a separate edition, not a change to main ARC-1

## Status
Accepted (2026-05-29)

## Context
ARC-1 (the main TypeScript project) is a **redistributable, multi-user, BTP-deployable**
MCP server that hand-rolls the ADT HTTP client (CSRF, locking, XML, etc.) and
does **per-user principal propagation**. The idea here is to instead **delegate
ADT work to SAP's `adt-ls`** (the headless Eclipse ABAP language server bundled
in the `sapse.adt-vscode` extension). But `adt-ls` is:
- **non-redistributable** (SAP Developer License — see ADR-0002),
- **single-session** (logs on as one identity at a time — no native multi-tenancy),
- **heavy** (a ~127 MB JVM/Eclipse process),
- **interactive-auth oriented** (SSO/reentrance — hostile to headless; see ADR-0006).

Those traits directly conflict with main ARC-1's mission (lightweight, multi-user
PP, shippable npm/Docker). Folding adt-ls into main ARC-1 would compromise all of it.

## Decision
Build **arc-1-lsp as a separate edition/repo** — the **single-developer / desktop
(or single-tenant) sibling** to main ARC-1. It reuses ARC-1's *shell* (see
ADR-0003) but is its own product with its own lifecycle. Main ARC-1 stays
unchanged.

## Consequences
- Clean separation: main ARC-1 keeps multi-user PP + redistributability; arc-1-lsp
  optimizes for code-reuse-via-adt-ls on a single box / single tenant.
- Some duplication (the "shell") — mitigated by ADR-0003 (port now, shared module
  later).
- Two products to maintain.

## Revisit when
- adt-ls becomes **multi-user / lightweight / redistributable** — then the two
  editions could converge, or arc-1-lsp could replace main ARC-1's engine.
- SAP ships an **official headless/server ADT runtime** designed for this.

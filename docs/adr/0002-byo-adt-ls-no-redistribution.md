# ADR-0002: BYO adt-ls — never bundle or redistribute the SAP binary

## Status
Accepted (2026-05-29)

## Context
`adt-ls` ships inside the `sapse.adt-vscode` VS Code extension under the **SAP
Developer License Agreement v3.2**: a *non-exclusive, non-transferable,
non-sublicensable, non-redistributable* license for dev use on "a Computer You
own or control," and clause (d) prohibits *mass data extraction from an SAP
product to a non-SAP product*. arc-1-lsp is intended to be public (npm/GitHub/
container). Bundling adt-ls in our repo/image would violate the license.

## Decision
arc-1-lsp **ships no SAP binaries**. The licensed developer/admin **provides**
adt-ls; arc-1-lsp only **discovers and drives** what's already on their machine
(`src/adt-ls/discovery.ts`): `ARC1_ADT_LS_PATH` → `vendor/adt-ls/` (build-time
injection, gitignored) → the newest installed `sapse.adt-vscode-*` extension. For
containers, the admin injects the platform-specific adt-ls at **build time** (the
linux-x64 binary is extracted from the official VSIX into `vendor/adt-ls/`, which
is `.gitignore`d) — see `scripts/extract-adt-ls.mjs`.

## Consequences
- Legally clean: the SAP↔developer license is untouched; arc-1-lsp is just a tool
  using a locally-installed binary (like reusing an installed JDK).
- The developer/admin must install the extension / supply the VSIX.
- CI cannot compile/test against adt-ls (it isn't present) → adt-ls-dependent
  tests are `skipIf`-gated.
- The container image is **built privately** by the licensed admin, not published
  by us with adt-ls inside.
- Clause (d) (mass data extraction) is the *operator's* responsibility — same as
  SAP's own MCP-server-feeding-an-LLM path; surface it in user docs.

## Revisit when
- SAP **licenses adt-ls for redistribution** or ships a **standalone, freely
  redistributable** ADT runtime → we could bundle it and drop the BYO dance.

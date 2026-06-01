# Plan 11 — LSP code-intelligence tools (textDocument/*)

Research + capability map: [adt-ls-reference.md §9](../adt-ls-reference.md). Direction
from SAP (Thomas Ritter): adt-ls is a language server — expose the **standard LSP
APIs as thin proxy tools**; LLMs know LSP well. This corrects the earlier (wrong)
"navigation hangs" verdict — the fix was `didOpen` as a **notification**.

## Goal
Add LSP code-intelligence tools backed by `engine.lsp` (didOpen → query → didClose):
the navigation/outline/where-used/type-hierarchy/syntax-check surface that the MCP
authoring loop lacked. Live-verified methods only.

## What to implement (live-verified §9)
| Tool | LSP method(s) | Value |
|---|---|---|
| `document_symbols` | `textDocument/documentSymbol` | object outline (kinds + ranges + children) |
| `go_to_definition` | `textDocument/definition` | jump to a symbol's definition |
| `find_references` | `textDocument/references` (timeout-guarded) | where-used (bounded symbols) |
| `type_hierarchy` | `prepareTypeHierarchy` + `typeHierarchy/{supertypes,subtypes}` | inheritance / impls tree |
| `check_syntax` | `textDocument/diagnostic` | ABAP syntax check **without activating** |
| `completion` | `textDocument/completion` | code completion at a position |

**Skip (researched, §9):** `hover` (returns null at every position headless),
`declaration` (≈definition), `documentHighlight`/`codeLens`/`semanticTokens` (low
LLM value). Documented so we don't re-investigate.

## Design
- **New module `src/adt-ls/navigation.ts`** — `createNavigation({ lsp, lifecycle })`
  (reuses `lifecycle.resolveAffUri` for name→URI + `readFile` for content; all reads,
  ungated).
  - `withOpenDocument(ref, fn)`: resolve URI → `readFile` → `didOpen` (notification)
    → `try fn(uri, content)` → **`finally didClose`** (always clean up).
  - `resolvePosition(uri, locator)`: explicit `line`/`character` (**1-based** in the
    API → 0-based for LSP) wins; else `symbol` (name) resolved to its
    `selectionRange.start` via `documentSymbol` (declared symbols only — class/
    method/attribute/type/interface); else throw listing available symbols.
  - Methods: `documentSymbols(ref)`, `goToDefinition(ref, locator)`,
    `findReferences(ref, locator, {includeDeclaration})` (Promise.race w/ ~20s timeout
    → clear "too many references / narrow the symbol" error), `typeHierarchy(ref,
    locator, {direction:'supertypes'|'subtypes'|'both'})`, `checkSyntax(ref)`,
    `completion(ref, locator, {maxItems})` (cap items — completion lists are huge).
  - Output: thin/raw LSP results (Thomas: "expose LSP as-is"); ranges left 0-based as
    LSP returns them, documented.
- **Engine:** add `navigation: Navigation`; build it in `startEngine` from `lsp` +
  `lifecycle`. (No relogon concern beyond the existing `engine.lsp` wrapping.)
- **server.ts:** register the 6 tools (each: destination-bound via lifecycle's
  `dest()`; `name` + `objectType` + locator args). Tools are **reads** → scope `read`.
- **Stateless:** each call opens+closes its own document (matches stateless HTTP MCP).

## Tasks (each tool: implement → unit-test → live-probe → review)
1. **navigation.ts core** — `withOpenDocument` + `resolvePosition` + `documentSymbols`
   + `checkSyntax` (no position). Engine wiring (`engine.navigation`). Tests: fake
   `lsp` asserts didOpen/didClose + method/params; resolvePosition matrix.
2. **go_to_definition** + **find_references** (timeout) + **type_hierarchy** +
   **completion** (position-based). Tests: param shape, symbol→position, timeout path.
3. **server.ts** — 6 tools + scope wiring.
4. **policy.ts** — add the 6 tools to `TOOL_SCOPES` (all `read`); update the
   completeness test (21 → 27) + `server.test.ts` tool-name guard.
5. **Live smoke** (`navigation.smoke.test.ts`, gated): documentSymbols / definition /
   references(small) / type_hierarchy / check_syntax against a4h, read-only.
6. **Docs:** README tool list (reads 14 → 20; total 21 → 27), parity (SAPNavigate ❌→✅,
   SAPLint partial via check_syntax), CLAUDE map (navigation.ts), adt-ls-reference §8.

## Validation
- `build`/`typecheck`/`lint`/`test` green; navigation fully unit-tested.
- Live (with `ARC1_TEST_SAP_PASSWORD`): the smoke probes + a manual `find_references`
  on a small symbol (fast) vs a kernel class (timeout path).

## Out of scope / follow-up
- hover (revisit per adt-ls release — Thomas's prototype has it working, so the
  invocation likely differs).
- Open-document caching (v1 re-opens per call); name resolution for locals (use line/character).
- Combining tools into a unified `navigate` (the user said "combine later").

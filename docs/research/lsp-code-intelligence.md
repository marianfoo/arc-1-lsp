# Research: LSP code-intelligence for arc-1-lsp — Claude Code LSP plugin vs. MCP-LSP-proxy

> **Status: IMPLEMENTED** (plan 11 → `src/adt-ls/navigation.ts`, now **9 tools** — the
> reuse effort added `hover`, `go_to_declaration`, `document_highlight`). This is the
> research that led to the build; the live capability map + shapes are consolidated in
> [`adt-ls-reference.md` §9](../adt-ls-reference.md) and the decompiled surface in
> [`research/adt-ls-capability-map.md`](adt-ls-capability-map.md). Option B (MCP-LSP-proxy)
> was chosen; Option A (a direct Claude Code LSP plugin) is not viable for remote ABAP (§2).
> NOTE: the body below pre-dates the build — its "skip hover (null)" / "❌ rows" notes are
> superseded: hover/highlight ARE wired (semanticTokens-primed, capability-map §3a), as is ATC.

**Question (2026-06-01):** Claude Code can host LSP plugins (jump-to-def, find-refs,
diagnostics). Can arc-1-lsp use that — or should it expose adt-ls's standard LSP
methods another way? How, what are the advantages, and why maybe not?

**Short answer:**
1. adt-ls **fully supports** standard LSP code-intelligence **headless** — PROVEN
   live (below). Our prior "navigation unreachable headless" verdict
   (`adt-ls-reference.md` §2) was a **bug in our spike** (sent `didOpen` as a
   *request*; it's a *notification*), not a real limit.
2. A **direct Claude Code LSP plugin → adt-ls is NOT viable for ABAP** — the plugin
   model drives a local binary over **local workspace files by extension**; ABAP
   source is remote (`abap:` AFF URIs) and adt-ls needs the whole logon/proxy
   orchestration. (SAP's Thomas Ritter: *"we can't directly attach the LS for
   ABAP, but it works via the proxy approach."*)
3. The viable path = **MCP-LSP-proxy tools** (expose `textDocument/*` as MCP tools,
   proxied to the already-connected adt-ls session). This is SAP's own prototype
   design — and the groundwork is already in our tree (`engine.lsp` +
   `driver.sendNotification`).

**Recommendation:** build the MCP-LSP-proxy navigation + diagnostics tools. It's
the **single biggest remaining capability gap** (SAPNavigate / where-used /
SAPLint-style diagnostics), now proven feasible, pure adt-ls (ADR-0003).

---

## 1. Evidence — what adt-ls actually supports

### Server capabilities (from LSP `initialize`, no SAP backend needed)
adt-ls `1.0.0.202605281240` advertises:

| Provider | adt-ls | Provider | adt-ls |
|---|---|---|---|
| `definitionProvider` | ✅ | `documentSymbolProvider` | ✅ |
| `referencesProvider` | ✅ | `declarationProvider` | ✅ (`scheme: abap`) |
| `hoverProvider` | ✅ | `typeHierarchyProvider` | ✅ (`scheme: abap`) |
| `completionProvider` | ✅ | `semanticTokensProvider` | ✅ (full legend) |
| `documentHighlightProvider` | ✅ | `diagnosticProvider` | ✅ (pull; no inter-file) |
| `codeLensProvider` | ✅ | `textDocumentSync.openClose` | ✅ |
| `documentFormatting` / `rename` / `codeAction` | ❌ (not advertised) | | |

Document selectors are `{language: "abap", scheme: "abap"}` — adt-ls expects the
**`abap:` URI scheme** (our repotree AFF URIs), **not `file://`**.

### Live end-to-end proof (a4h, read-only, `CL_ABAP_TYPEDESCR`)
```
resolveAffUri → abap:/repotree-v1/A4H/System Library/.../cl_abap_typedescr.clas.abap
textDocument/didOpen (NOTIFICATION, with source text)   → no hang
textDocument/documentSymbol  → [{name:"CL_ABAP_TYPEDESCR", kind:5, range:…, children:[…]}]  (full symbol tree)
textDocument/diagnostic      → {kind:"full", items:[]}   (the ADT syntax check, pull-model)
textDocument/didClose        → clean
```
The earlier hang was `didOpen` sent as an awaited **request** (no response ever
comes — it's fire-and-forget). With `driver.sendNotification` it works.
**→ `adt-ls-reference.md` §2 `navigation`/`ATC` ❌ rows are wrong; update to ✅ when built.**

---

## 2. Option A — a Claude Code LSP plugin (`.lsp.json` / `lspServers`)

**Mechanism** (Claude Code plugin reference): an entry maps a language server to
`command` + `args` + `transport` (`stdio`|`socket`) + `extensionToLanguage`
(e.g. `".go": "go"`) + `workspaceFolder` + `initializationOptions` + `settings`.
Claude Code's **built-in LSP tool** spawns the binary and drives it against
**workspace files**, keyed by extension, to surface diagnostics/definition/refs/hover.

**Why it doesn't fit ABAP:**
- **adt-ls is not a point-at-a-folder binary.** It needs headless logon: a
  TLS-terminating reverse proxy (ADR-0005), reentrance-ticket emulation (ADR-0006),
  a created+logged-on destination, and (for creation) its embedded MCP server. The
  LSP-plugin schema has **no place** for SAP URL/credentials/destination/proxy.
- **There are no local `.abap` files.** Source lives in the SAP system, reached via
  `abap:/repotree-v1/…` AFF URIs. Claude Code's LSP tool opens `file://` workspace
  files; there's nothing local to open, and `extensionToLanguage` never triggers.
- adt-ls's providers select on `scheme: "abap"` — it wouldn't serve `file://` docs.

→ A direct plugin is the wrong shape for a *remote* language server behind auth.
The "create your own LSP plugin" path is for languages whose **source is on disk**.

## 3. Option B — MCP-LSP-proxy (recommended)

arc-1-lsp is already an MCP server already connected to adt-ls. Expose the standard
methods as **MCP tools**, proxied to adt-ls over the live session. LLMs know LSP
semantics, so the tools are intuitive and cheap on schema tokens. SAP's own
prototype does exactly this:

| Proposed MCP tool | adt-ls LSP method | Purpose |
|---|---|---|
| `go_to_definition` | `textDocument/definition` | jump to symbol definition |
| `find_references` | `textDocument/references` | all references (where-used) |
| `hover` | `textDocument/hover` | signature + docs at a position |
| `document_symbols` | `textDocument/documentSymbol` | class/intf/program outline + ranges |
| `type_hierarchy` | `textDocument/prepareTypeHierarchy` (+ super/subtypes) | inheritance across implementing classes |
| `diagnostics` | `textDocument/diagnostic` | the ADT syntax check **without activation** |

(Also available if wanted: `declaration`, `completion`, `documentHighlight`,
`semanticTokens`, `codeLens`.)

**How it plugs into what we have:**
- `engine.lsp` (already added) = relogon-wrapped `sendRequest` + raw `sendNotification`.
- File-URI resolution is **already solved**: `search → getLsUri` → repotree AFF URI
  (SAP solves this with a Skill; we have the resolver). Reuse `lifecycle.resolveAffUri`.
- Per call: `resolveAffUri` → `readSource` → `didOpen{uri,languageId:'abap',version,text}`
  → `textDocument/<method>` → `didClose`. Gate as `read` scope (ADR-0007).
- Position-taking methods (definition/references/hover) need a `{line,character}`;
  `document_symbols` returns ranges, so a name→position step can feed them.

## 4. Advantages
- **Closes the biggest gap.** Navigation/where-used and ATC/lint were the headline
  "→ use main arc-1" items; this brings them into arc-1-lsp, pure adt-ls.
- **Diagnostics without activation.** `textDocument/diagnostic` is the ADT syntax
  check — faster authoring feedback than the activate round-trip we use today.
- **Cheap + intuitive for LLMs.** Standard LSP shapes; minimal schema tokens.
- **Powerful for ABAP/RAP.** `typeHierarchy` walks OO/RAP inheritance across
  implementing classes — hard to do otherwise.
- **On-strategy.** Matches "it's a language server" (Thomas) and Claude Code's
  code-intelligence direction, without abandoning the MCP shell.

## 5. Why maybe NOT / risks
- **Stateful document lifecycle.** Unlike our stateless read/write tools, nav needs
  `didOpen`(with full source)→query→`didClose`. Leaking open docs or version
  desync is a new failure mode; needs disciplined close + a watchdog.
- **A `read_source` round-trip per call** (the server parses the text *you* send on
  `didOpen`; positions are relative to it) — unless we cache open docs.
- **Position ergonomics.** definition/references/hover want `{line,character}`;
  deriving that from a symbol name needs a `documentSymbol` lookup first.
- **Reverse-engineered against a private build.** Pin to the adt-ls version; the
  startup version-warning (W2) already flags drift.
- **Possible SAP duplication.** SAP's prototype already exposes `adt_lsp_*` tools.
  **If SAP ships those in adt-ls's MCP, federate theirs instead of maintaining
  ours.** Worth raising with Thomas before investing heavily.
- **Not the built-in LSP tool.** These are MCP tool-calls, not Claude Code's native
  editor-grade LSP integration (which needs local files) — slightly less seamless.
- **Surface creep** beyond today's clean 21 tools.

## 6. Recommendation
1. **Build the MCP-LSP-proxy** tools (`diagnostics`, `document_symbols`,
   `go_to_definition`, `find_references`, `hover`, `type_hierarchy`) on `engine.lsp`,
   read-scoped, reusing `resolveAffUri`. Start with `diagnostics` + `document_symbols`
   (no position needed) — fastest proof + high value — then the position-based three.
2. **Do not** pursue a direct Claude Code LSP plugin for ABAP — wrong shape (remote
   URIs + logon orchestration).
3. **Coordinate with SAP (Thomas).** If `adt_lsp_*` ships in adt-ls's MCP, prefer
   federating SAP's tools over ours. Until then, ours closes the gap.
4. On build: correct `adt-ls-reference.md` §2 (navigation/ATC → ✅) and the
   `arc-1-feature-parity.md` SAPNavigate/SAPLint rows.

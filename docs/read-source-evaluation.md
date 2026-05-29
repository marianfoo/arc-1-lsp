# Evaluation — unblocking `read_source` (and source-dependent reads)

Date: 2026-05-29. All claims live-tested against a4h through the connected engine.

> **CORRECTION (2026-05-29, later same day):** the premise below — that `readFile`
> is blocked headless — was a **wrong-URI-shape mistake**. `readFile` **WORKS** with
> the canonical **repotree/AFF URI** (`abap:/repotree-v1/<dest>/…/<obj>.clas.abap`,
> single-slash) — it returns the source. The `{}` results used the wrong shape
> (`abap://<dest>/sap/bc/adt/…`). So **Approach A (adt-ls readFile) is actually
> viable**, not just B. The genuine remaining gap is resolving an *existing*
> object's AFF URI **by name** (search returns ADT paths, not repotree URIs). See
> `docs/arc-1-feature-parity.md` §2/§4 for the corrected picture. The comparison
> below is kept for the reasoning, but read it with this correction in mind.

## The blocker (recap)
adt-ls's `adtLs/fileSystem/readFile {uri}` returns `{}` headless for hand-built
`abap://` URIs. Source-dependent reads (read_source, where-used, documentSymbol,
table data) all route back to adt-ls's VS Code-driven workspace/tree model. See
`docs/adt-ls-tool-surface.md`.

## Alternatives investigated

### A — Crack the workspace/tree model (the "pure" adt-ls way)
The real FS root is `abap:/repotree-v1/<dest>` (from `getFolderUri{destination,
folderType:0}`), and `readDirectory` **does** traverse it headless:
`A4H → "Local Objects ($TMP)" / "System Library" → DEVELOPER → objects`.
**But:**
- The tree is **package-organized**, not name-keyed. `search_objects` returns ADT
  paths (`/sap/bc/adt/oo/classes/cl_x`), NOT repotree URIs — there's no clean
  name→repotree-uri resolver. So "read CL_X by name" means traversing packages.
- `readDirectory` children are `{name, type}` only — **no URI**. Child URIs must be
  reconstructed, and encoding is exact: `getFolderUri` emits `%28%24TMP%29` but
  `encodeURIComponent` leaves `()` unescaped → a reconstructed URI returned **empty
  children** (drill broke). Fragile.
- Never confirmed `readFile` on a leaf returns content (the encoding trap blocked it).
- **Verdict:** viable for a *package-browser* tool; awkward, fragile, and indirect
  for source-by-name. High effort, medium reliability, pure (uses adt-ls only).

### B — Direct authenticated ADT GET through arc-1-lsp's own reverse proxy ✅
arc-1-lsp already holds the creds + runs the TLS reverse proxy (+ CC bridge). A
plain Basic-auth GET works:
- `GET /sap/bc/adt/oo/classes/cl_abap_typedescr/source/main` (Accept: text/plain)
  → **200, the real ABAP source** (23 KB). The ADT path comes straight from
  `search_objects`. **No CSRF, no lock, no stateful session, no XML** (source/main
  is plain text), no version quirks — the most stable ADT endpoint there is.
- `GET /sap/bc/adt/ddic/tables/t000` → 200 XML (richer reads work too, but need the
  right `Accept` MIME + XML parsing — more hand-rolling).
- Reuses the existing proxy/bridge → works identically in DIRECT and CC modes.
- **Verdict:** reliable, by-name (via search→path), minimal code. **Deviates from
  ADR-0003** ("zero hand-rolled ADT") — but only in *letter*: a read GET carries
  none of the complexity ADR-0003 guards against (CSRF/locking/XML/activation/
  version-quirks). Low effort, high reliability.

Two sub-options:
- **B-minimal:** source GET only (`<adt-uri>/source/main`, plain text). ~1 small
  module + a type→path map. Bounded, trivial. Unblocks `read_source`.
- **B-full:** port arc-1's read client (source + metadata + where-used + table
  data). Unblocks everything read, but reintroduces the system-specific ADT read
  code the edition set out to *delete* — a real retreat from the premise.

### C — Wait for SAP (re-check each adt-ls release)
adt-ls's MCP is "experimental"; SAP may add a get-source tool/LSP method. Zero
effort, no timeline, no control. Keep as a standing watch-item regardless.

### D — Capture/replay adt-ls's session via the proxy
The proxy could harvest adt-ls's session cookie and reuse it. Unnecessary (Basic
auth already works, B) and fragile. **Rejected.**

## Comparison

| | works? | by name? | effort | reliability | ADR-0003 fit | unlocks |
|---|---|---|---|---|---|---|
| A tree model | partial (browse yes, leaf unconfirmed) | no (package-organized) | high | medium (fragile URIs) | ✅ pure | package browsing |
| **B-minimal** | **yes** | **yes** | **low** | **high** | ⚠ letter only | read_source |
| B-full | yes | yes | medium | high | ❌ retreat | all reads |
| C wait | n/a | n/a | none | n/a | ✅ | maybe, someday |

## Recommendation
**B-minimal**, framed as a deliberate, documented scope clarification (new ADR):
*reads may use a thin direct ADT HTTP GET; all mutations/activation/transport stay
in adt-ls.* It cleanly unblocks the flagship `read_source` by name, reuses the
connection infra we already built, and the deviation is bounded (read-only,
stateless, plain text). Revisit toward B-full only if where-used/table-data become
priorities; keep A in the back pocket for a future package-browser tool; keep C as
a standing watch-item to delete B if SAP ships a native get-source.

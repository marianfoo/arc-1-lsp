# adt-ls capability reference (authoritative)

**The single source of truth for what arc-1-lsp can drive in SAP's `adt-ls`, how,
and what it can't.** Every row is live-verified against a4h (S/4HANA 2023, kernel
7.58); the evidence (exact call + response/error) is summarized inline. When you
learn something new about adt-ls, **add it here** with the call + observed result.

Scope reminder (ADR-0003): arc-1-lsp uses adt-ls **only** — no direct HTTP ADT, no
hybrid. What adt-ls can't do headless is **out of scope** (→ main ARC-1), and the
gaps below are an honest map of adt-ls's headless limits, not defects to patch.

Two channels: **MCP** (adt-ls's own `/mcp`, federated via `engine.callTool`, stable)
and **LSP** (`adtLs/*` custom requests via `driver.sendRequest`, private/reverse-
engineered). Connection recipe (logon, TLS, truststore): `docs/adt-ls-headless-notes.md`.

> **Deeper map:** for the *complete* decompiled-server inventory (all 23 `adtLs/*`
> segments / ~92 methods, per-method DTO shapes + usefulness triage + wiring gap), see
> [`docs/research/adt-ls-capability-map.md`](research/adt-ls-capability-map.md). It is
> ground-truth (decompiled `com.sap.adt.ls`), and corrects the **hover** / **ATC** /
> **formatting** verdicts below — those rows now carry the corrected reading inline.

## 1. The URI model — the thing to get right

adt-ls represents objects as **AFF files** in a repository tree. There are **two
URI shapes; only one works for content**:
- ✅ **repotree/AFF URI** (canonical): `abap:/repotree-v1/<DEST>/<folders…>/<OBJ>/<file>`
  — **single slash** after `abap:`. Example:
  `abap:/repotree-v1/A4H/Local%20Objects%20%28%24TMP%29/DEVELOPER/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap`
- ❌ **ADT-path URI**: `abap://<DEST>/sap/bc/adt/oo/classes/zcl_x/source/main` —
  double slash. `getObjectName` *parses* it but `readFile`/`activate` **reject** it
  (return `{}`). Earlier "blocked" verdicts were this mistake.

**Resolver (name → repotree URI) — SOLVED, one call:**
`search_objects` gives an **ADT path** (`/sap/bc/adt/oo/classes/cl_x`); then
```
adtLs/repository/getLsUri  { destination, adtUri: "<ADT path>" }  → { uri: "<repotree AFF URI>" }
```
⚠ the param key is **`adtUri`** (not `uri` → "Internal error"; not a bare string →
"could not be parsed"). Works for **every** object type. So the by-name chain is:
**`search_objects` → `getLsUri` → `readFile`/`writeFile`/`activate`** — no tree
traversal needed.

**AFF filenames per type** (the `<file>` segment): class `…clas.abap` (+ includes,
§3); interface `…intf.abap`; CDS `…ddls.acds`; access control `…dcls.acds`; service
binding `…srvb.json`. Classic types get a `…<type>.jsonc` placeholder (§4).

**Encoding gotcha:** segments use exact percent-encoding — `(`→`%28`, `)`→`%29`,
`$`→`%24`, space→`%20`. `encodeURIComponent` does NOT encode parens → wrong URI →
silent empty result. **Don't hand-build URIs — use the one `getLsUri`/`create` returns.**

## 2. Capability matrix (verified)

| Capability | Call | Works? | Notes |
|---|---|---|---|
| List destinations | MCP `abap_list_destinations` | ✅ | wired `list_destinations` |
| Search objects | LSP `repository/quickSearch` `{destination,pattern,types}` | ✅ | wired `search_objects`; field is `pattern` not `query` |
| List users | LSP `repository/getUsers` `{destination}` | ✅ | wired `list_users` |
| Creatable types | MCP `abap_creation-get_all_creatable_objects` | ✅ | wired `list_creatable_objects` — = the supported-type set |
| Object-type fields | MCP `abap_creation-get_object_type_details` `{destination,objectType,name}` | ✅ | wired `get_object_type_details` → `{fields}` |
| Generators | MCP `abap_generators-list_generators`/`get_schema` | ✅ | `list_generators` ✅. `get_schema` requires **all 5** args (per adt-ls `tools/list`): `destination`, `generatorId`, `packageName`, `referencedObjectType`, `referencedObjectName` — the two refs may be `""`. `get_generator_schema` now sends all (package → `$TMP` default, refs → `""` default) + accepts explicit `package`/`referencedObjectType`/`referencedObjectName`. **Object-referencing** generators (a4h's `uiservice`/`webapiservice`, built *from* an object) need a real `referencedObjectType` (`TABL`/`DDLS`/`BDEF`) + name, else "referencedObjectType is not valid. Expected one of: TABL". |
| Service binding info | MCP `abap_business_services-fetch_services` `{destination,serviceBindingName}` | ✅ | wired `get_service_binding` |
| Inactive list | LSP `activation/getInactiveObjects` `{destinationId}` | ✅ | wired `list_inactive_objects` (returned `[]` even mid-edit — semantics unclear) |
| **Resolve name→URI** | LSP `repository/getLsUri` `{destination,adtUri}` | ✅ | §1 — the key enabler, unwired |
| **Read source** | LSP `fileSystem/readFile` `{uri:<repotree>}` | ✅ | → `{content}`; supported types only (§4); unwired |
| **Create object** | MCP `abap_creation-create_object` `{destination,objectType,objectContent,transportRequestNumber}` | ✅ | `objectContent` = **JSON string** `{name,packageName,description}`; `transportRequestNumber` is a **top-level** arg (`''`=local/$TMP, else a real TR for transportable packages — required by the schema); returns the AFF filePath; mutating |
| **Update source** | LSP `fileSystem/writeFile` `{uri,content}` | ✅ | `content` = **plain multi-line** source (NOT base64 — 255-char/line limit); no manual lock needed; mutating |
| **Activate** | MCP `abap_activate_objects` `{destination,uris:[<repotree>]}` | ✅ | → `{success, objectDiagnostics:[{lsUri,diagnostic:[{range,…}]}]}` — **structured errors on failure** (§5); mutating |
| **Run unit tests** | MCP `abap_run_unit_tests` `{destination,uris:[<repotree>]}` | ✅ | → results / "No tests found" |
| **Lock / unlock** | LSP `fileSystem/{lockFile,unlockFile,getFileLockStatus}` `{uri}` | ✅ | `{operationExecuted:true}`; writeFile doesn't require it |
| **Delete object** | LSP `fileSystem/delete` `{uri:<…clas.json>}` | ✅ | delete the **`.json`** metadata file (not `.abap`); mutating |
| **Generate objects** | MCP `abap_generators-generate_objects` `{destination,generatorId,content,packageName,transportRequestNumber,referencedObjectType,referencedObjectName}` | ✅ | wired `generate_objects` — runs a RAP generator → full service (table/CDS/BDEF/SRVD/SRVB); mutating, gated; `content` = JSON string matching get_schema |
| **Validate creation** | MCP `abap_creation-run_validation` `{destination,objectType,objectContent}` | ✅ | wired `validate_object` — pre-create check; `objectContent` like create. Live ($TMP CLAS, valid): `{"message":"ABAP Class validated successfully"}` |
| **Transport (find)** | MCP `abap_transport-get` `{destination,objectName,objectType,developmentPackage,isCreation}` | ✅ | wired `find_transport` — object-scoped TR lookup (read). Live ($TMP, isCreation): `{"isRecordingRequired":false,"transportRequests":[],"informationMessages":[]}`. ⚠ **`abap_transport-*` are DYNAMIC backend IDE-Action tools** (`AdtMCPToolsIdeActionCollector`, not in `plugin.xml`) — present only when the connected system ships `MCP_TRANSPORT-*` actions; version/system-dependent. The robust typed alternative is native LSP `adtLs/cts/transport/*` (always compiled in); `assignTransportToObject` has **no** federated equivalent (capability-map §4c/§5). |
| **Transport (create)** | MCP `abap_transport-create` `{destination,developmentPackage,transportDescription,isCreation,objectName?,objectType?}` | ✅ | wired `create_transport` — mutating, gated by `allowTransportWrites` (+`allowWrites`). **Requires `objectName`** (backend: "objectName is missing" without it). ⚠ **Creates a real TR even for `$TMP`** (the backend does NOT short-circuit local packages — live-verified, then deleted via ADT since no release/delete tool exists). Always `find_transport` first — it correctly reports `isRecordingRequired:false` for `$TMP`, so you skip `create_transport` entirely. |
| Service info | MCP `abap_business_services-fetch_service_information` (7 args from fetch_services output) | ✅ | wired `get_service_details` — OData URL/entity-sets for one service |
| **LSP code-intelligence** | LSP `textDocument/*` (didOpen → query → didClose) | ✅ | **§9 — CORRECTED.** documentSymbol / definition / declaration / references / prepareTypeHierarchy(+supertypes/subtypes) / diagnostic / completion all work headless. Earlier "hangs" was sending `didOpen` as a *request*; it's a **notification** (driver now has `sendNotification`). **CDS/DDLS caveat (2026-06-02):** `documentSymbol` returns `[]` for CDS headless, so `symbol`-based resolution can't use the outline — `resolvePosition` now falls back to a **word-boundary scan of the source text** to locate a CDS element (or pass explicit line+character). `completion` and `typeHierarchy` results have their opaque `data` blob stripped (token efficiency; resolve isn't exposed). |
| **Syntax check (pull)** | LSP `textDocument/diagnostic` | ✅ | §9 — the ABAP syntax check ADT runs, WITHOUT activating; `{kind:'full',items:[…]}`. (Distinct from ATC; both are wired + complementary.) |
| **ATC (deep checks)** | LSP `adtLs/atc/runCheck` | ✅ | **WIRED + live-verified (`run_atc`/`list_atc_variants`).** Pass empty `checkVariant` → backend system-default variant (`AtcCheckService.getSystemDefaultCheckVariant`). `getCheckVariants` needs a **non-empty** `quickPickUserInput` (`*` = all, defaulted by the tool; empty → backend "Parameter value must not be empty") **and an anchor `objectUri`** — so `list_atc_variants` requires `name` + `objectType` (the variants are system-wide, but the backend retrieves them in an object's context). a4h returns **15+ variants** (CI_INA1_CONSISTENCY, CHECKMAN_SECURITY, ACTIVATION, …). Object key = `objectUri` (repotree). Busy-polls server-side → 60 s client timeout. `AtcRunFinding{lineNumber,priority,message,checkId,…}`, report-only. → capability-map §3c. |
| Formatting / pretty-print | LSP `textDocument/formatting` | ◐ | **CORRECTED 2026-06-02 (decompile).** `setDocumentFormattingProvider(false)` at init → static no-op. **But** per-type `*FormatService` classes exist and `AbstractAdtFormatService` does a **dynamic per-URI `client/registerCapability` on `didOpen`** — a client honoring dynamic registration could get ABAP Pretty-Printer formatting. → probe before calling it a SAP gap (capability-map §3b). |
| Revision history | — | ❌ | no `adtLs/repository/getRevisions`/`getVersions` (probed — "unsupported"). |
| Free SQL / data preview | — | ❌ | no such method |
| Git (gCTS/abapGit) | — | ❌ | not exposed |

## 3. Class includes (AFF files)

`readDirectory` on a class folder shows the object split into AFF files:
`…clas.abap` (main), `…clas.definitions.abap` (CCDEF), `…clas.implementations.abap`
(CCIMP), `…clas.macros.abap`, `…clas.testclasses.abap` (CCAU), `…clas.json`
(metadata). So **include-level read/write** is possible by targeting the right
`…clas.<include>.abap` file (matches arc-1's include editing).

## 4. Object-type support matrix — the big boundary

`getLsUri` resolves **all** types, but `readFile` only returns **source** for the
**modern ABAP-Cloud / RAP** object set; **classic/legacy** types return a `.jsonc`
placeholder: *"The object is not supported in ADT in VS Code. Please use ADT in
[Eclipse]."*

- ✅ **Supported (source served):** CLAS (class), INTF (interface), DDLS (CDS view),
  DCLS (access control), SRVB (service binding); and by the creatable-set: DDLX
  (metadata ext), BDEF (behavior def), SRVD (service def), DRAS (CDS aspect), CDS
  types. → these are arc-1-lsp's create/read/edit/activate scope.
- ❌ **NOT supported (placeholder → use Eclipse):** PROG (program), TABL (table),
  FUGR/FUNC (function group), DOMA (domain), DTEL (data element), MSAG (message
  class), TTYP (table type), XSLT, SHLP, ENHO, … → **arc-1's domain.**

This is *the* reason arc-1 (which hand-rolls every type) has broader coverage: the
VS-Code `adt-ls` targets clean-core/ABAP-Cloud development, not classic ABAP.

## 5. The proven object lifecycle (supported types, pure adt-ls)

```
search_objects(name)                      → ADT path                 (existing objects)
getLsUri{destination,adtUri}              → repotree AFF URI
create_object{objectType,objectContent}  → AFF filePath              (new objects — no resolver needed)
writeFile{uri, content:<plain source>}   → null                      (edit; per-include via …clas.<inc>.abap)
readFile{uri}                            → {content}                 (read back)
activate{uris:[uri]}                     → {success, objectDiagnostics} (syntax errors w/ ranges on failure)
run_unit_tests{uris:[uri]}               → results
delete{uri:<…json>}                      → null                      (the .json metadata file)
```
Activation's `objectDiagnostics` is the **syntax/error feedback** for an authoring
loop (no separate syntax-check method found). Lock/unlock available but not required
for `writeFile`.

## 6. Gotchas / hard-won lessons

- Use the URI that `create`/`getLsUri` **returns**; never hand-build (encoding trap).
- `objectContent` (create) is a **JSON string**, not an object.
- `writeFile` content is **plain multi-line** source; base64 → "line exceeds 255".
- `delete` targets the **`.clas.json`**, not `.clas.abap` ("Please delete the *.json file").
- `textDocument/didOpen` is a **notification** — sending it as a *request* hangs the
  driver (no response). The driver needs a `sendNotification` to use LSP doc features.
- adt-ls processes from `.vscode`/`.cursor` you see running are the **user's IDEs** — never kill.
- Always test mutations in **`$TMP`** and clean up (delete the `.json`); a hung spike
  skips its `finally` → orphan object. Verify with `search_objects ZCL_…*`.

## 7. SAP session lifecycle & self-heal (logged-off recovery)

After the reentrance-ticket logon (§ headless-notes), adt-ls holds a SAP **security
session** for the destination. That session **expires server-side on inactivity**
(SAP default ~hours; profile-dependent). Once it lapses, **every** ADT call — LSP
*and* federated MCP — fails with **"Your user was logged off"** until the
destination logs on again. Observed live on the deployed CF instance: after the
instance sat idle, `search_objects` / `list_users` / generators all returned
logged-off, and only an instance restart recovered it.

**Recovery (verified mechanism):** the reentrance-ticket handler stays registered
on the driver for the process lifetime, so calling `adtLs/destinations/ensureLoggedOn`
**again** re-fires it and re-establishes the session — the exact path proven at
startup. There is **no** `logoff`/`disconnect` method; `ensureLoggedOn` is the lever.
adt-ls also emits `adtLs/destinations/logonStateChanged` (`pending`→`connected`)
as the state transitions.

**What arc-1-lsp does (`src/adt-ls/session-retry.ts` + `engine.ts`):** both channels
are wrapped so a detected logged-off failure triggers one `ensureLoggedOn` +
`setMcpDestination` re-logon and **retries the call once**. Concurrent failures
share a single in-flight re-logon. Exposed as `engine.reconnect()` for ops/manual
recovery. Detection matches the SAP "logged off" phrase, session-expiry variants,
and explicit HTTP 401 (not bare `401`, to avoid false positives).

> Residual uncertainty: forcing a *real* server-side expiry in a unit/spike is not
> cheap (full inactivity timeout), so the heal-of-a-dead-session path is verified by
> reuse of the proven startup logon + the gated `engine.reconnect()` live test
> (`tests/unit/server/engine-reconnect.smoke.test.ts`, idempotent re-logon against
> a4h) rather than a forced-expiry test. If a future adt-ls makes `ensureLoggedOn`
> no-op when it *believes* it is connected, add a getLogonInfo-gated forced re-auth.

> **⚠ Correction + escalation (2026-06-02, ADR-0008):** the "~hours / only a restart
> recovers" claim above is SUPERSEDED. On a4h the session dies in **< 3 min** of idle, and
> the failure most often does **NOT** carry the "logged off" string — repository searches
> return **empty** and CTS throws **"Internal error"** while `health` still says connected.
> So the §7 string-matching self-heal (`withRelogon`) is necessary but **not sufficient**:
> a dead session must be detected by **probing a known object** (`makeReviveIfDead`), and
> the heal runs both reactively (on a persistent empty/"Internal error") and via an
> **activity-gated keep-alive**. No restart is ever needed now. The full model + the
> cold-start retry + `health.backendLive` are in §8's resilience bullets and **ADR-0008**.

## 8. What this means for arc-1-lsp (wired tools)

- **Reads (live):** search_objects, read_source, list_users, list_inactive_objects,
  list_generators, get_generator_schema, get_object_type_details, get_service_binding,
  get_service_details, validate_object, find_transport, list_creatable_objects,
  list_destinations, health.
- **Authoring loop (live, modern types, behind `ARC1_ALLOW_WRITES` + package allowlist):**
  create_object, update_source, activate_object, run_unit_tests, delete_object —
  by name via `getLsUri`; full create→edit→activate→test→delete live-verified.
  Safety: `src/server/safety.ts`. Lifecycle: `src/adt-ls/lifecycle.ts`.
- **Generation + transport (live, gated):** `generate_objects` (RAP generator →
  full service; `ARC1_ALLOW_WRITES`), `create_transport` (CTS TR; additionally
  `ARC1_ALLOW_TRANSPORT_WRITES`), `assign_transport` (native, transport-gated),
  `list_transports` + `get_lock_status` (native reads). `create_object`/`generate_objects`
  accept a transport for non-$TMP packages.
- **Code-intelligence (§9, the LSP channel):** documentSymbol, definition, declaration,
  references, type-hierarchy, diagnostics (syntax check), completion, **hover**,
  **document_highlight** (last two semanticTokens-primed, §9) — all live via `textDocument/*`.
- **Quality / runtime / services (live):** `run_atc` + `list_atc_variants` (ATC),
  `run_unit_tests_with_coverage`, `run_application` (console), `service_binding_details`,
  `publish_service_binding` (write-gated). **39 tools total.**
- **Out of scope (→ arc-1):** classic object types, free SQL, git, transport
  *release/delete*.
- **Cold-start handling (2026-06-02):** the SAP-side caches behind adt-ls are COLD on a
  fresh connect (and after idle) — the first repository search returns `[]` and the CTS
  list throws "Internal error" for a few seconds until warm. Two guards: (1) a startup
  `warmUpBackend()` primes search + CTS before the server serves; (2) a per-call
  cold-retry (`src/adt-ls/cold-retry.ts`) retries an empty search result OR a transient
  "Internal error" with backoff, on `engine.search` / `resolveAffUri` / `listTransports`.
- **Dead-session detection + keep-alive (2026-06-02) — the BIGGER one.** A SAP session
  that idle-expires does NOT emit the "logged off" string the `withRelogon` self-heal
  watches for — adt-ls just returns EMPTY searches + CTS "Internal error", while `health`
  still reports the destination connected. So cold-retry alone would retry a dead session
  forever. `makeReviveIfDead` (session-retry.ts) probes a known-present object; an
  empty/failed probe ⇒ dead ⇒ force a re-logon (`reconnect()`), then the caller retries.
  Wired **reactively** (engine.search / resolveAffUri on persistent empty; listTransports
  on persistent "Internal error") and **proactively** as a keep-alive heartbeat that keeps
  the session from expiring + self-heals if it did. `health` now carries `backendLive` (last
  real round-trip succeeded) so agents can tell a live session from a connected-but-dead one
  — `connectedDestination` alone is just destination metadata.
- **Keep-alive: activity-gated + backendLive accuracy (2026-06-02, live-tuned).** CF logs
  proved the session dies in **<3 min** of idle and ONLY a full re-logon revives it (a
  probe-retry doesn't) — so the heartbeat can't *prevent* the death, it heals it. A plain
  3-min (or even 2-min) heartbeat therefore re-logs on 24/7 on an idle server (~480/day,
  audit-log noise). Fix = **activity-gated keep-alive**: the heartbeat (every 3 min) only
  runs within `KEEPALIVE_ACTIVITY_WINDOW_MS` (15 min) of the last USER call, so an active
  session stays warm (fast calls) but an idle server goes quiet; the next user call after a
  lapse self-heals via the **reactive revive** (a one-time ~re-logon cost on that call). The
  keep-alive probe uses the RAW driver so it doesn't count as activity (else it'd never let
  the session lapse). Separately: a successful re-logon sets `backendLive=true`, and a
  one-shot probe runs at the end of warm-up, so `health.backendLive` is accurate from the
  first call. `backendLive` is last-known (refreshed by the heartbeat + every search/re-logon),
  NOT a per-call probe — a `health` call does not itself round-trip the backend.

## 9. LSP code-intelligence (`textDocument/*`) — the second channel

adt-ls is a **language server**, so beyond its MCP tools + the `adtLs/*` custom
LSP it speaks the **standard LSP**. The `initialize` response advertises the
supported providers (authoritative — dump it from `init.capabilities`):
`hover, completion(+resolve), definition, declaration, references,
documentHighlight, documentSymbol, codeLens, typeHierarchy, semanticTokens(full),
diagnostic`; formatting/rename/signatureHelp/callHierarchy/implementation/
workspaceSymbol are **absent**.

**The flow (per object):** resolve name → repotree AFF URI (§1 `getLsUri`) →
`readFile` for content → **`textDocument/didOpen` (a NOTIFICATION** —
`{textDocument:{uri,languageId:'abap',version:1,text}}`) → query → `textDocument/didClose`.
⚠ The earlier "navigation hangs" verdict was a **mistake**: `didOpen` was sent as a
*request* (no response → deadlock). It's a notification — the driver now has
`sendNotification` (`LspClient`); the engine exposes `engine.lsp`.

**Live-verified against a4h (`CL_ABAP_TYPEDESCR` + a $TMP probe class), 2026-06-01:**

| Method | Works? | Shape / notes |
|---|---|---|
| `textDocument/documentSymbol` | ✅ | hierarchical `DocumentSymbol[]` — `{name,kind,range,selectionRange,children}` (kind = LSP SymbolKind: 5 class, 6 method, 11 interface, 19 object/friend, …). The object outline. |
| `textDocument/definition` | ✅ | `LocationLink[]` (`originSelectionRange`, `targetUri`, `targetRange`, `targetSelectionRange`). Position must be on an **identifier**. |
| `textDocument/declaration` | ✅ | `LocationLink[]` — ~same as definition for ABAP. |
| `textDocument/references` | ✅* | `Location[]` (`{uri,range}`). **\*Bounded symbols only** — a local var returned 4 hits instantly; on a kernel class (`CL_ABAP_TYPEDESCR`, used everywhere) it **"Internal error"s / hangs** (where-used volume). MUST wrap in a timeout. `context.includeDeclaration` honored. |
| `textDocument/prepareTypeHierarchy` | ✅ | `TypeHierarchyItem[]` at the class-name identifier; `item.data.subtypes` carries a ready tree (name/adtUri/type/packageName/children). |
| `typeHierarchy/supertypes` / `subtypes` | ✅ | `TypeHierarchyItem[]` — full inheritance/impl tree (e.g. CL_ABAP_TYPEDESCR → CL_ABAP_OBJECTDESCR → CL_ABAP_CLASSDESCR). This is "method implementations across implementing classes". |
| `textDocument/diagnostic` | ✅ | `{kind:'full',items:[…]}` — the **ABAP syntax check ADT runs, without activating**. Empty items = clean. Pull-model (no position). |
| `textDocument/completion` | ✅ | `CompletionList` `{isIncomplete,items:[{label,labelDetails,kind,textEdit,…}]}`. Large (keywords + context). |
| `textDocument/semanticTokens/full` | ✅ | `{data:[…]}` LSP-encoded token ints + the legend from capabilities. Low LLM value (raw highlighting). |
| `textDocument/hover` | ✅ | **WIRED + live-verified (`hover`).** Earlier "null headless / ask SAP" was wrong — it was **OUR bug, now fixed**. `AbapLsHoverService` short-circuits to null at `AbapTokenFilterService.shouldCallBackend`, which needs a hit in `AbapDocumentTokenCache` — primed **only** by `textDocument/semanticTokens/full` (`AbapSemanticTokensProvider.updateTokenCache`). `hover` now issues `semanticTokens/full` for the same URI at the same (unchanged) doc version, then hover → rich markdown (method signature + ABAP-Doc via `LsMethodMarkdownRenderer`). DDLS/JSON hover parse inline (no priming). → capability-map §3a. |
| `textDocument/documentHighlight` | ✅ | **WIRED (`document_highlight`).** Same gate as hover (`shouldCallBackend`) — `[]` until the token cache is primed; `document_highlight` primes `semanticTokens/full` first → read/write/text occurrences (`AbapLsDocumentHighlightService`). |
| `textDocument/codeLens` | ◐ | returns `[]`. Low value headless. |

**Positions:** LSP is 0-based `{line,character}`. For LLM-friendliness, position-based
tools resolve a **symbol name** → its `selectionRange.start` via `documentSymbol`
(works for declared symbols: class/method/attribute/type/interface), with an explicit
`line`/`character` fallback for locals/usages.

**Wired (LLM-valuable):** `document_symbols`, `go_to_definition`, `go_to_declaration`,
`find_references` (timeout-guarded), `type_hierarchy` (prepare+super+sub), `check_syntax`
(diagnostic), `completion`, and (semanticTokens-primed, §3a of capability-map) `hover` +
`document_highlight` — all live-verified. **Remaining:** `completionItem/resolve` —
would enrich completion items with signatures via the same backend, **without** the cache
gate. **Skip:** raw semanticTokens (sent only to prime hover/highlight), codeLens
(SRVB/JSON only). See `docs/research/adt-ls-capability-map.md`.

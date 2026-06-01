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
| **Transport (find)** | MCP `abap_transport-get` `{destination,objectName,objectType,developmentPackage,isCreation}` | ✅ | wired `find_transport` — object-scoped TR lookup (read). Live ($TMP, isCreation): `{"isRecordingRequired":false,"transportRequests":[],"informationMessages":[]}` (→ $TMP needs no transport) |
| **Transport (create)** | MCP `abap_transport-create` `{destination,developmentPackage,transportDescription,isCreation,objectName?,objectType?}` | ✅ | wired `create_transport` — mutating, gated by `allowTransportWrites` (+`allowWrites`) |
| Service info | MCP `abap_business_services-fetch_service_information` (7 args from fetch_services output) | ✅ | wired `get_service_details` — OData URL/entity-sets for one service |
| **LSP code-intelligence** | LSP `textDocument/*` (didOpen → query → didClose) | ✅ | **§9 — CORRECTED.** documentSymbol / definition / declaration / references / prepareTypeHierarchy(+supertypes/subtypes) / diagnostic / completion all work headless. Earlier "hangs" was sending `didOpen` as a *request*; it's a **notification** (driver now has `sendNotification`). |
| **Syntax check (pull)** | LSP `textDocument/diagnostic` | ✅ | §9 — the ABAP syntax check ADT runs, WITHOUT activating; `{kind:'full',items:[…]}`. (Distinct from `atc/runCheck` ATC, still unreached.) |
| ATC (deep checks) | LSP `atc/runCheck` | ❌ | "Object to be checked could not be determined" for every param shape. Unreached (≠ the syntax-check diagnostic above, which works). |
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
  `ARC1_ALLOW_TRANSPORT_WRITES`). `create_object`/`generate_objects` accept a
  transport for non-$TMP packages. **21 tools total.**
- **Code-intelligence (§9, the LSP channel):** documentSymbol, definition,
  references, type-hierarchy, diagnostics (syntax check), completion — all work
  headless via `textDocument/*`.
- **Out of scope (→ arc-1):** classic object types, ATC deep checks (`atc/runCheck`),
  free SQL, git, transport *release/delete*.

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
| `textDocument/hover` | ◐ | provider advertised but returns **`null`** at every position tried (class name, method, local var, type ref). Effectively non-functional headless — **skip** (revisit per release; Thomas's prototype has it working, so the invocation may differ). |
| `textDocument/documentHighlight` | ◐ | returns `[]` even on a used local var. Low value. |
| `textDocument/codeLens` | ◐ | returns `[]`. Low value headless. |

**Positions:** LSP is 0-based `{line,character}`. For LLM-friendliness, position-based
tools resolve a **symbol name** → its `selectionRange.start` via `documentSymbol`
(works for declared symbols: class/method/attribute/type/interface), with an explicit
`line`/`character` fallback for locals/usages.

**Implement (LLM-valuable):** `document_symbols`, `go_to_definition`, `find_references`
(timeout-guarded), `type_hierarchy` (prepare+super+sub), `check_syntax` (diagnostic),
`completion`. **Skip (researched):** hover (null), declaration (≈definition),
documentHighlight/codeLens/semanticTokens (low value). See plan 11.

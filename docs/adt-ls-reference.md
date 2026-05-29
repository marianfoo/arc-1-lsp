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
| Generators | MCP `abap_generators-list_generators`/`get_schema` | ✅ | wired `list_generators`/`get_generator_schema` |
| Service binding info | MCP `abap_business_services-fetch_services` `{destination,serviceBindingName}` | ✅ | wired `get_service_binding` |
| Inactive list | LSP `activation/getInactiveObjects` `{destinationId}` | ✅ | wired `list_inactive_objects` (returned `[]` even mid-edit — semantics unclear) |
| **Resolve name→URI** | LSP `repository/getLsUri` `{destination,adtUri}` | ✅ | §1 — the key enabler, unwired |
| **Read source** | LSP `fileSystem/readFile` `{uri:<repotree>}` | ✅ | → `{content}`; supported types only (§4); unwired |
| **Create object** | MCP `abap_creation-create_object` `{destination,objectType,objectContent}` | ✅ | `objectContent` = **JSON string** `{name,packageName,description}`; returns the AFF filePath; mutating |
| **Update source** | LSP `fileSystem/writeFile` `{uri,content}` | ✅ | `content` = **plain multi-line** source (NOT base64 — 255-char/line limit); no manual lock needed; mutating |
| **Activate** | MCP `abap_activate_objects` `{destination,uris:[<repotree>]}` | ✅ | → `{success, objectDiagnostics:[{lsUri,diagnostic:[{range,…}]}]}` — **structured errors on failure** (§5); mutating |
| **Run unit tests** | MCP `abap_run_unit_tests` `{destination,uris:[<repotree>]}` | ✅ | → results / "No tests found" |
| **Lock / unlock** | LSP `fileSystem/{lockFile,unlockFile,getFileLockStatus}` `{uri}` | ✅ | `{operationExecuted:true}`; writeFile doesn't require it |
| **Delete object** | LSP `fileSystem/delete` `{uri:<…clas.json>}` | ✅ | delete the **`.json`** metadata file (not `.abap`); mutating |
| Validate creation | MCP `abap_creation-run_validation` | ◐ | needs the full `objectContent` like create |
| Transport read | MCP `abap_transport-get` | ◐ | needs `{destination,developmentPackage,objectName,objectType,isCreation}` |
| **ATC / lint** | LSP `atc/runCheck` | ❌ | "Object to be checked could not be determined" / "Internal error" for every param shape (`{uris}`,`{uri}`,`{objectUri}`,`+checkVariant`). Unreached. |
| **Navigation / where-used** | LSP `textDocument/{documentSymbol,definition,references,hover}` | ❌ | `didOpen`-then-query **hangs**; not how adt-ls surfaces these |
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

## 7. What this means for arc-1-lsp (wired tools)

- **Reads (live):** search_objects, read_source, list_users, list_inactive_objects,
  list_generators, get_generator_schema, get_object_type_details, get_service_binding,
  list_creatable_objects, list_destinations, health.
- **Authoring loop (live, modern types, behind `ARC1_ALLOW_WRITES` + package allowlist):**
  create_object, update_source, activate_object, run_unit_tests, delete_object —
  by name via `getLsUri`; full create→edit→activate→test→delete live-verified.
  Safety: `src/server/safety.ts`. Lifecycle: `src/adt-ls/lifecycle.ts`.
- **Out of scope (→ arc-1):** classic object types, ATC/lint, navigation/where-used,
  free SQL, git, transport writes, RAP generation.

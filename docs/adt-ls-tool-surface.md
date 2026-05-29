# adt-ls tool surface — what's reachable headless (for building arc-1 tools)

Live-probed against a4h (2026-05-29) via the connected engine. Two channels:
**federated MCP** (adt-ls's own `/mcp`, stable) and **LSP** (`adtLs/*` custom
requests). Param shapes below are verified unless marked.

## Federated MCP tools (14) — `engine.callTool(name, args)`
All take a `destination` (the connected destination id) + their own args:
- `abap_list_destinations` — `{}` → connected destinations.
- `abap_creation-get_all_creatable_objects` `{destination}` → object-type catalog. ✅ wired as `list_creatable_objects`.
- `abap_creation-get_object_type_details` `{destination,objectType,name}` → `{fields:[…]}` creation metadata (read). ✅ wired as `get_object_type_details`.
- `abap_creation-run_validation` / `create_object` — object creation (mutating).
- `abap_activate_objects` `{uris:[…]}` — activate. ❌ BLOCKED headless: "URI does not
  contain a AFF file name" (needs the workspace AFF URI, not a raw path).
- `abap_run_unit_tests` `{uris:[…]}` — run ABAP Unit. ❌ BLOCKED headless: "Project
  could not be determined from URI" (needs a project/workspace-resolved URI). Same
  root as read_source — see `docs/arc-1-feature-parity.md` §4.
- `abap_transport-get` — needs `{destination,developmentPackage,objectName,objectType}` (NOT just destination — "developmentPackage missing"); `abap_transport-create` (mutating).
- `abap_generators-list_generators` `{destination}` → `{generators:[{title,description}]}` (read). ✅ wired as `list_generators`. `get_schema` `{destination,generatorId}` → schema (read). ✅ wired as `get_generator_schema`. `generate_objects` (mutating).
- `abap_business_services-fetch_services` `{destination,serviceBindingName}` → OData service info. ✅ wired as `get_service_binding` (binding names via `search_objects types:["SRVB/SVB"]`). `fetch_service_information` needs `{serviceBindingName,serviceName,serviceVersion}` (not wired).

## LSP methods — `driver.sendRequest(method, params)`
Verified working headless:
- **`adtLs/repository/quickSearch`** `{destination, maxResults, pattern, types:[]}`
  → `{references:[{name, description, type, uri}], message}`. **The search field is
  `pattern` (NOT `query`); `destination` (NOT `destinationId`).** `uri` is the ADT
  object path (e.g. `/sap/bc/adt/oo/classes/cl_abap_typedescr`). ✅ → `search_objects`.
- **`adtLs/activation/getInactiveObjects`** `{destinationId}` → `[]` (inactive drafts). ✅ wired as `list_inactive_objects`.
- **`adtLs/repository/getUsers`** `{destination}` (NOT destinationId) → `{users:[{id,text}]}`. ✅ wired as `list_users`.
- `adtLs/abapUnit/capabilities` `{destinationId}` → support flags.
- `adtLs/destinations/list` `{}` → configured destinations (with protocol/url). `listSystemConfigurations` → `[]` on a4h.
- `adtLs/destinations/createProject` — bare string `"<dest>"` → `true` (sets up the
  destination project; params are NOT `{destinationId}` — that throws "could not be parsed").
- `adtLs/fileSystem/getObjectName` `{uri}` → object name (parses the URI locally).

Need an object/uri arg (not just destination), so usable once we pass one:
- `adtLs/atc/{runCheck, getCheckVariants}` — ATC (needs an object).
- `adtLs/cts/transport/*` — transport assign/search/lock.
- `adtLs/activation/activate` — activate (mutating).
- `adtLs/textDocument/insertProposal` — quickfix.

## ⚠ HARD BLOCKER — `read_source` via `adtLs/fileSystem/readFile`
The extension reads source with `sendRequest('adtLs/fileSystem/readFile', {uri})`
→ `{content}` (then `Buffer.from(content,'utf8')`). The URI scheme is **`abap://`**
(not `adt://`); the form `abap://<dest>/sap/bc/adt/oo/classes/<name>/source/main`
is **syntactically valid** (`getObjectName` parses it, returns the include name).

**But `readFile` always returns `{}` headless** — and `abapStat` returns `{}`,
`stat` says "File not found", `readDirectory` on a folder → "Internal error" —
even after `createProject`, a `quickSearch` (whose reference `uri` we reuse),
`textDocument/didOpen`, and `abapStat` priming. Root cause: adt-ls's FS provider
only materializes a file's content for URIs surfaced through **VS Code's
workspace-folder + tree (`readDirectory`) model**; that tree is driven by VS Code
adding an `abap://` workspace folder and the editor's FS layer walking it. Headless
we have no workspace-folder mechanism, and `readDirectory` (the traversal that
would register nodes) errors on hand-built folder URIs. The folder identity is
`(destination, folderType)` (see `getFolderUri` "Destination and folder type must
not be null"; `folderType` is numeric 0/2), not a plain path — so the abap: path
URIs don't map to browsable folders without the VS Code layer.

**Options for later (not yet done):**
1. Replicate enough of the workspace/tree model headless — register an `abap://`
   root, drive `readDirectory` by `(destination, folderType)` to materialize nodes,
   then `readFile`. Needs reverse-engineering `getFolderUri`'s folderType enum +
   the readDirectory folder-URI contract.
2. Re-check each adt-ls release — SAP may expose a direct "get source" LSP/MCP
   method (none today; the MCP tool set is creation/activation/transport/generators).
3. Last resort (violates ADR-0003 "zero hand-rolled ADT"): fetch source from the
   backend ourselves via our own reentrance session — explicitly avoided.

So `read_source` (SAPRead) is **deferred** until option 1 or 2 lands. `search_objects`
covers object discovery; `list_creatable_objects` + `list_inactive_objects` +
generators/transport give a useful read-only surface meanwhile.

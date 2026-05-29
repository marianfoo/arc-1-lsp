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
- `abap_activate_objects` `{uris:[<AFF filePath>]}` — activate. ✅ **WORKS** with the
  repotree AFF URI (`abap:/repotree-v1/<dest>/…/<obj>.clas.abap`) → `{success:true}`.
  (The earlier "URI does not contain a AFF file name" was a wrong-URI-shape error.)
- `abap_run_unit_tests` `{uris:[<AFF filePath>]}` — run ABAP Unit. ✅ **WORKS** with
  the AFF URI → results / "No tests found". (Not yet wired.) See
  `docs/arc-1-feature-parity.md` §2.
- `abap_creation-create_object` `{destination,objectType,objectContent}` — ✅ **WORKS**;
  `objectContent` is a JSON **string** `{name,packageName,description}`; returns the
  AFF filePath. (Mutating; not yet wired.) `fileSystem/readFile` on the AFF
  `.clas.abap` URI returns source; `fileSystem/delete` on the `.clas.json` removes it.
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

## ✅ `read_source` via `adtLs/fileSystem/readFile` — WORKS (corrected 2026-05-29)
`sendRequest('adtLs/fileSystem/readFile', {uri})` → `{content}` (utf8 source) when
given the **canonical repotree/AFF URI** — single-slash `abap:/repotree-v1/<dest>/
<folders…>/<OBJ>/<obj>.clas.abap`. Proven: returned a real class's source.

The earlier "always returns `{}`" was a **wrong-URI-shape mistake** — those calls
used `abap://<dest>/sap/bc/adt/…/source/main` (double-slash, ADT-path), which
`getObjectName` parses but `readFile` rejects (returns `{}`). NOT a workspace-model
block. `create_object` returns the AFF filePath directly; `delete` takes the
`.clas.json`; `activate`/`run_unit_tests` take the `.clas.abap` URI — all proven.

**Remaining gap (engineering, not a wall):** resolving an *existing* object's AFF
URI **by name** — `search_objects` returns ADT paths, not repotree URIs, and the
tree is package-organized. For reads, sidestep with a direct ADT GET
`<adt-path>/source/main` (also proven). For create-flow objects the URI is already
in hand. See `docs/arc-1-feature-parity.md` §2/§4 for the full corrected picture.

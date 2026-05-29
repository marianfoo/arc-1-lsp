# arc-1 vs arc-1-lsp — feature comparison + implementation rationale

What the two editions cover, and for every adt-ls-reachable capability: **is it
wired, and why / why not.** All "why not" claims are backed by live probes against
a4h (S/4HANA 2023, kernel 7.58) on 2026-05-29 — the error strings are quoted as
evidence. See also `docs/adt-ls-tool-surface.md` (raw method map) and
`docs/read-source-evaluation.md` (the workspace-model blocker + workarounds).

## 1. The architectural difference (frames everything)

| | arc-1 (main) | arc-1-lsp |
|---|---|---|
| ADT protocol | **hand-rolled** (CSRF, locking, XML, version quirks) | **delegated to SAP's `adt-ls`** |
| Source files / LOC | 86 / ~38,600 | 21 / ~1,825 |
| Test files | 98 | 18 |
| Stage | production, write-capable, multi-user | early read-only single-user (CF-live) |
| System-specific code to own | ~29 ADT files | ~zero |

arc-1-lsp trades breadth for ~5% of the code: SAP's binary does the hard ADT work.
The cost is being bound to what `adt-ls` exposes **headless** — which, as Part 3
shows, is narrower than what it does inside VS Code.

## 2. Tool coverage (arc-1's 12 intent tools → arc-1-lsp)

| arc-1 tool | arc-1-lsp today | Status |
|---|---|---|
| SAPRead (source, method surgery, table data, versions) | — | ❌ blocked (workspace model; workaround proven, on hold) |
| SAPSearch (search, tadir_lookup) | `search_objects` | ✅ covered |
| SAPWrite (create/update/delete, surgery, DDIC, RAP, AFF) | — | ❌ blocked/complex (Part 3) |
| SAPActivate (activate, publish SRVB) | `list_inactive_objects` (read side) | ◑ read-only side; activate blocked |
| SAPNavigate (def/refs/where-used/completion) | — | ❌ blocked (needs open docs) |
| SAPQuery (free SQL) | — | ❌ not in adt-ls surface |
| SAPTransport (list/get/create/release/…) | — | ◑ `transport-get` reachable but clunky (Part 3) |
| SAPGit (gCTS + abapGit) | — | ❌ not in adt-ls surface |
| SAPContext (deps/usages/impact, compression) | — | ❌ depends on source reads |
| SAPLint (abaplint, format) | — | ❌ ATC needs an object (Part 3) |
| SAPDiagnose (dumps, traces, syntax, unit tests, ATC) | — | ❌ unit tests blocked (Part 3) |
| SAPManage (package CRUD, FLP, UI5, features) | `list_generators`, `get_generator_schema`, `get_object_type_details`, `get_service_binding` | ◑ RAP generators + service bindings + creation metadata |
| *(adt-ls-native extras)* | `health`, `list_destinations`, `list_users` | ✅ |

**arc-1-lsp read tools (10):** health, list_destinations, list_creatable_objects,
search_objects, list_inactive_objects, list_users, list_generators,
get_generator_schema, get_object_type_details, get_service_binding.

## 3. adt-ls-native capability matrix — implemented? why / why not

Every federated MCP tool + the key LSP methods, with the live verdict.

| Capability (adt-ls call) | Wired? | Why / why not (evidence) |
|---|---|---|
| Search — `repository/quickSearch` | ✅ `search_objects` | works `{destination,pattern,types}` |
| Users — `repository/getUsers` | ✅ `list_users` | works `{destination}` |
| Creatable types — `abap_creation-get_all_creatable_objects` | ✅ `list_creatable_objects` | works `{destination}` |
| Object-type fields — `abap_creation-get_object_type_details` | ✅ `get_object_type_details` | works `{destination,objectType,name}` → `{fields}` |
| Generators — `abap_generators-list_generators` / `get_schema` | ✅ `list_generators` / `get_generator_schema` | work `{destination[,generatorId]}` |
| Inactive list — `activation/getInactiveObjects` | ✅ `list_inactive_objects` | works `{destinationId}` |
| Service bindings — `abap_business_services-fetch_services` | ✅ `get_service_binding` | works `{destination,serviceBindingName}` → OData info; names via `search_objects types:["SRVB/SVB"]` |
| Service info — `fetch_service_information` | ◐ not wired | works but needs `{serviceBindingName,serviceName,serviceVersion}` (3 args); low marginal value over `get_service_binding` |
| Transport read — `abap_transport-get` | ◐ deferred | reachable but needs `{destination,developmentPackage,objectName,objectType,isCreation}` (5 args, evidence: "developmentPackage missing" then "isCreation missing"); clunky + hard to test on a $TMP-only trial. Wire on request. |
| **Run unit tests** — `abap_run_unit_tests` / `abapUnit/runTests` | ❌ **blocked** | **"Project could not be determined from URI"** for ADT-path AND `abap://` URIs; LSP form → "Internal error". Needs a project/workspace-resolved URI (§4). |
| **Activate** — `abap_activate_objects` / `activation/activate` | ❌ **blocked** | **"URI does not contain a AFF file name"** — needs the `abap://` AFF workspace URI, not a raw path (§4). Also mutating. |
| **Create object** — `abap_creation-create_object` | ❌ **blocked (complex)** | **"Cannot read field name because objectContent is null"** — needs a filled `objectContent` (the `objectCreation/getCreationUiModelAndContent` form model), not `{name,package}`. Constructible but non-trivial; mutating. |
| Validate creation — `abap_creation-run_validation` | ◐ partial | **"Enter valid object properties"** — same `objectContent` requirement as create. |
| Generate objects — `abap_generators-generate_objects` | ❌ not wired | mutating; needs a filled generator schema; same content-construction effort as create. |
| ATC — `atc/runCheck` / `getCheckVariants` | ❌ blocked | **"Object to be checked could not be determined"** — needs a resolved object/URI (§4). |
| Transport search — `cts/transport/searchTransports` | ❌ blocked | "Internal error" with `{destination}`; param shape unresolved. |
| Free SQL / data preview | ❌ absent | no such method in adt-ls's MCP or LSP surface. |
| Git (gCTS/abapGit) | ❌ absent | not exposed by adt-ls. |

Read-only tools that need no object context → **all wired**. The rest cluster into
three buckets: the **workspace-model block** (§4), the **objectContent-construction
effort** (create/generate/validate), and **absent capabilities** (SQL, git).

## 4. The shared root blocker — adt-ls's workspace / project / AFF model

`read_source`, `run_unit_tests`, `activate`, `atc`, and `navigation` all fail for
**one** underlying reason: adt-ls's MCP/LSP operations resolve objects through its
**VS Code-driven workspace model** — a project (`destinations/createProject`), an
`abap://` file tree (`repotree-v1`, browsed via `getFolderUri`+`readDirectory`),
and AFF file URIs. Headless we can log on + call destination-scoped queries, but we
don't drive that tree the way the VS Code FS layer does, so:
- `readFile` returns `{}` (read_source),
- unit tests can't resolve a "project" from a URI,
- activate wants an "AFF file name" URI.

**Alternatives (evaluated, see `read-source-evaluation.md`):**
- **A — crack the workspace model**: traverse `abap:/repotree-v1/<dest>` to get
  canonical URIs. *Tested:* the tree traverses, but it's package-organized (not
  name-keyed), children lack URIs, and URI reconstruction has encoding traps →
  fragile + indirect. Would unblock read/test/activate together if hardened.
- **B — direct ADT HTTP through arc-1-lsp's own reverse proxy**: *proven* for
  source (`GET …/source/main` → 200). Extends to activate (POST
  `/sap/bc/adt/activation`), unit tests (POST the AUnit runner), ATC — but each is
  more hand-rolled ADT (XML, and CSRF for the mutating ones), eroding the edition's
  premise the further it goes.
- **C — wait for SAP** to expose project-free MCP/LSP operations (the MCP server is
  "experimental").

**Decision (2026-05-29): on hold.** `read_source` was explicitly deferred; since
unit-tests/activate share the same root, they're deferred with it. B-minimal
(source GET only) is the ready-to-go unblock if/when green-lit.

## 5. Bottom line + roadmap

- **Reachable without the workspace model → done.** Every destination-scoped read
  adt-ls offers headless is now a tool (search, users, generators, creatable types,
  object-type fields, service bindings, inactive list) — 10 read tools, live on CF.
- **The frontier is one blocker.** read_source + unit-tests + activate + navigation
  all wait on the workspace-model decision (A vs B vs C), currently on hold.
- **Bounded extras** available on request: `transport-get` (clunky args),
  `fetch_service_information`, and the create/generate family (needs objectContent
  construction + a write-safety layer — which arc-1 has and arc-1-lsp would need).
- **Genuinely absent in adt-ls:** free SQL (SAPQuery) and git (SAPGit) — these would
  always require arc-1-style direct implementations, never adt-ls.

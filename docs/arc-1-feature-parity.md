# arc-1 vs arc-1-lsp — feature comparison + implementation rationale

What the two editions cover, and for every adt-ls-reachable capability: **is it
wired, and why / why not.** All claims are backed by live probes against a4h
(S/4HANA 2023, kernel 7.58) — the authoring loop 2026-05-29, the full 39-tool
surface re-verified end-to-end through the MCP server 2026-06-02.

> **Status (2026-05-29):** the full ABAP **authoring loop is implemented** in
> arc-1-lsp — read_source, create, update, activate, run_unit_tests, delete — pure
> adt-ls, behind a write-safety layer, live-verified on a4h. The by-name resolver
> (`getLsUri`) is solved. **39 tools** (plan 07 added generation/transport/validation;
> plan 11 added LSP code-intelligence; the reuse effort added hover/highlight/declaration,
> ATC + coverage, run_application, service-binding details/publish, native transport).
> (History: an earlier version of this doc
> wrongly called these "blocked by a workspace-model limitation" — that was a
> wrong-URI-shape mistake; the canonical repotree/AFF URIs work headless.)

## 1. The architectural difference (frames everything)

| | arc-1 (main) | arc-1-lsp |
|---|---|---|
| ADT protocol | **hand-rolled** (CSRF, locking, XML, version quirks) | **delegated to SAP's `adt-ls`** |
| Source files / LOC | 86 / ~38,600 | 28 / ~3,500 |
| Test files | 98 | 36 |
| Stage | production, write-capable, multi-user | reads + code-intel + quality + authoring + runtime; **39 tools** |
| System-specific code to own | ~29 ADT files | ~zero |
| Object-type scope | all (classic + modern) | **modern ABAP-Cloud only** (§4); classic → arc-1 |
| Write safety | allowWrites + pkg allowlist + 7 scopes + deny-actions | allowWrites + pkg allowlist (v1) |

## 1b. Feature matrix — arc-1's 12 intent tools → arc-1-lsp

| arc-1 tool | arc-1-lsp | Notes |
|---|---|---|
| **SAPRead** (source) | ✅ `read_source` | modern types only; classic → arc-1 |
| **SAPSearch** | ✅ `search_objects` | quickSearch |
| **SAPWrite** (create/update/delete) | ✅ `create_object`/`update_source`/`delete_object` | modern types; behind `allowWrites`; include-aware. No method-surgery/AFF-validation/batch yet. |
| **SAPActivate** | ✅ `activate_object` (+ `list_inactive_objects`) | returns syntax diagnostics |
| **SAPDiagnose** (unit tests) | ✅ `run_unit_tests` + `run_unit_tests_with_coverage` | + coverage; no dumps/traces (ATC → SAPLint `run_atc`) |
| **SAPManage** (partial) | ◑ `list_generators`/`get_generator_schema`/**`generate_objects`**/`get_object_type_details`/**`validate_object`**/`get_service_binding`/**`get_service_details`** | RAP generation now wired; no package CRUD / FLP / UI5 |
| **SAPNavigate** (def/refs/where-used) | ✅ `go_to_definition`/`go_to_declaration`/`find_references`/`document_symbols`/`type_hierarchy`/`hover`/`document_highlight` | LSP `textDocument/*` — **works headless** (didOpen-as-notification; §9). hover/highlight are semanticTokens-primed. Corrects the earlier "unreached" verdict. |
| **SAPLint** (ATC/abaplint) | ✅ `check_syntax` + `run_atc` | `check_syntax` = LSP `textDocument/diagnostic` (ABAP syntax, no activation); `run_atc` = ABAP Test Cockpit deep checks (system-default variant). No abaplint (that's arc-1's local linter). |
| **SAPQuery** (free SQL) | ❌ | absent in adt-ls → arc-1 |
| **SAPTransport** | ◑ `find_transport`/`list_transports`/`get_lock_status` (read) + `create_transport`/`assign_transport` (write, gated) | object-scoped find + my-transports list + lock status + TR create/assign (native `adtLs/cts/transport`); no release/delete (→ arc-1) |
| **SAPGit** | ❌ | absent in adt-ls → arc-1 |
| **SAPContext** (deps/compression) | ❌ | depends on navigation → arc-1 |
| *(adt-ls extras)* | ✅ `health`, `list_destinations`, `list_creatable_objects`, `list_users`, `run_application` (console run), `service_binding_details`, `publish_service_binding` (write) | RAP service-exposure + console run — no direct arc-1 equivalent |

## 2. The URI lesson (why earlier verdicts were wrong)

adt-ls exposes objects as **AFF files** in a repository tree:
- canonical URI: `abap:/repotree-v1/<dest>/<folders…>/<OBJ>/<obj>.clas.abap`
  (source) + `…/<obj>.clas.json` (metadata). NOTE the single-slash `abap:/…`.
- `readFile` on the `.clas.abap` URI → **the source**. `activate` / `run_unit_tests`
  take that URI. `delete` takes the `.clas.json`. `create_object` **returns** the
  filePath.
- My earlier failures used `abap://<dest>/sap/bc/adt/…` (double-slash, ADT-path) —
  which `getObjectName` parses but `readFile`/`activate` reject. **That**, not any
  workspace limitation, was the "blocker."

**Proven end-to-end (created in `$TMP`, then deleted, system verified clean):**
create class → `readFile` returns its source → `activate` → `{success:true}` →
`run_unit_tests` → "No tests found" (call OK) → `delete` (.json) → gone.

## 3. adt-ls-native capability matrix — implemented? why / why not

| Capability | Headless? | Wired? | Notes / evidence |
|---|---|---|---|
| Search — `repository/quickSearch` | ✅ | ✅ `search_objects` | `{destination,pattern,types}` |
| Users — `repository/getUsers` | ✅ | ✅ `list_users` | `{destination}` |
| Creatable types / object-type fields | ✅ | ✅ `list_creatable_objects` / `get_object_type_details` | |
| Generators — `abap_generators-*` | ✅ | ✅ `list_generators` / `get_generator_schema` / `generate_objects` | generate scaffolds a full RAP service; gated |
| Inactive list — `getInactiveObjects` | ✅ | ✅ `list_inactive_objects` | |
| Service bindings — `fetch_services` | ✅ | ✅ `get_service_binding` | |
| **read_source** — `fileSystem/readFile` | ✅ | ✅ `read_source` | by name via `getLsUri`; modern types only (§4); include-aware |
| **create_object** — `abap_creation-create_object` | ✅ | ✅ `create_object` | `objectContent`=JSON string; returns AFF filePath; gated by `allowWrites`+package allowlist |
| **update source** — `fileSystem/writeFile` | ✅ | ✅ `update_source` | plain source (not base64); include-aware; gated |
| **activate** — `abap_activate_objects` | ✅ | ✅ `activate_object` | → `{success, diagnostics:[{range}]}` (syntax errors); gated |
| **run_unit_tests** — `abap_run_unit_tests` | ✅ | ✅ `run_unit_tests` | by name; ungated |
| **delete** — `fileSystem/delete` | ✅ | ✅ `delete_object` | deletes the `.clas.json`; gated |
| lock / unlock — `fileSystem/{lockFile,unlockFile}` | ✅ | (internal) | adt-ls locks on write; not exposed as a tool |
| validate creation — `abap_creation-run_validation` | ✅ | ✅ `validate_object` | pre-create check; same input as create |
| **ATC** — `adtLs/atc/runCheck` | ✅ | ✅ `run_atc` | empty `checkVariant` → system default; `objectUri` = repotree AFF URI; busy-polls (60 s timeout). `list_atc_variants` needs a non-empty query (`*`). Live-verified — corrects the earlier "unreached" verdict. |
| **navigation** — `textDocument/{documentSymbol,definition,references,hover,…}` | ✅ | ✅ `document_symbols`/`go_to_definition`/`find_references`/`hover`/… | `didOpen` is a **notification** (the earlier "hangs" sent it as a request); hover/highlight need a `semanticTokens/full` prime. Live-verified. |
| transport find — `abap_transport-get` | ✅ | ✅ `find_transport` | object-scoped TR lookup (read) |
| transport create — `abap_transport-create` | ✅ | ✅ `create_transport` | CTS TR; gated by `allowTransportWrites` |
| service info — `abap_business_services-fetch_service_information` | ✅ | ✅ `get_service_details` | OData URL/entity-sets for one service |
| **code coverage** — `adtLs/coverage/getCoverage` | ✅ | ✅ `run_unit_tests_with_coverage` | two-phase: `runTests(measurement=COVERAGE)` → `getCoverage`; statement/branch/procedure counts |
| **run application** — `adtLs/run/runApplication` | ✅ | ✅ `run_application` | run an `if_oo_adt_classrun` class / program → console output; live-verified |
| **service binding details/publish** — `adtLs/businessservice/srvb/*` | ✅ | ✅ `service_binding_details` / `publish_service_binding` (write) | native srvb segment (readFile-warms the SFS first); publish toggles the live OData service |
| **native transport** — `adtLs/cts/transport/*` | ✅ | ✅ `list_transports` / `assign_transport` (write) + `get_lock_status` (`fileSystem/getFileLockStatus`) | typed LSP transport vs the dynamic federated `abap_transport-*`; `assign_transport` has no federated equivalent |
| **hover / occurrences** — `textDocument/{hover,documentHighlight}` | ✅ | ✅ `hover` / `document_highlight` | semanticTokens-primed (the ABAP token-cache gate); hover = signature + ABAP-Doc |
| Free SQL / data preview | — | ❌ | **absent** from adt-ls |
| Git (gCTS/abapGit) | — | ❌ | **absent** from adt-ls |

## 4. The pure-adt-ls boundary (no hybrid — ADR-0003) + the type scope

arc-1-lsp uses adt-ls **only** — no direct HTTP ADT, even for an easy win. The
by-name resolver that gates existing-object ops is **solved purely in adt-ls**:
`repository/getLsUri {destination, adtUri}` maps a search-returned ADT path → the
repotree AFF URI in one call (no tree walk). So `search_objects → getLsUri →
readFile/writeFile/activate/delete` works by name. The direct-ADT-GET shortcut
stays **rejected** (it'd be a hybrid) — and it's not needed.

**The real boundary is OBJECT TYPE.** adt-ls-for-VS-Code serves source only for
**modern ABAP-Cloud types** (CLAS, INTF, DDLS, DCLS, SRVB, DDLX, BDEF, SRVD, …);
**classic types** (PROG, TABL, FUGR, DOMA, DTEL, MSAG, TTYP, XSLT, …) return a
`.jsonc` placeholder *"not supported in ADT in VS Code — use Eclipse."* So the
authoring loop covers modern objects; classic ABAP is **arc-1's domain.**

**Genuinely absent (any type):** free SQL, git, transport release/delete, debugger
(interactive DAP). **Genuinely blocked on SAP:** the unadvertised standard-LSP extras
(`implementation`/`rename`/`codeAction`/`callHierarchy`/`workspace/symbol`) and project-wide
`workspace/diagnostic`. (ATC and navigation/where-used — once thought unreached — are
**wired**; see §3a/§3c of the capability map.) Honest adt-ls limits → arc-1 territory.

## 5. What can be achieved in arc-1-lsp (pure adt-ls) — current state

**Live, wired (39 tools):**
- Reads: `search_objects`, `read_source`, `list_users`, `list_inactive_objects`,
  `list_generators`, `get_generator_schema`, `get_object_type_details`,
  `get_service_binding`, `get_service_details`, `validate_object`, `find_transport`,
  `list_creatable_objects`, `list_destinations`, `health`.
- **Code intelligence (LSP `textDocument/*`):** `document_symbols`, `go_to_definition`,
  `go_to_declaration`, `find_references`, `type_hierarchy`, `hover`,
  `document_highlight` (the last two semanticTokens-primed), `check_syntax`,
  `completion` — see §9 of the reference doc.
- **Quality & test:** `run_atc` + `list_atc_variants` (ABAP Test Cockpit),
  `run_unit_tests_with_coverage` (test result + coverage).
- **Runtime & business services:** `run_application` (console output),
  `service_binding_details`, `publish_service_binding` (write-gated).
- **Authoring loop (modern types, behind `ARC1_ALLOW_WRITES` + package allowlist):**
  `create_object`, `update_source`, `activate_object`, `run_unit_tests`,
  `delete_object` — full create→edit→activate→test→delete, by name, live-verified.
- **Generation + transport (gated):** `generate_objects` (RAP generator → full
  service), `create_transport` (CTS TR; additionally `ARC1_ALLOW_TRANSPORT_WRITES`),
  `assign_transport` (native), `list_transports` + `get_lock_status` (native reads).
  `create_object`/`generate_objects` accept a transport for non-$TMP packages.

**Not yet wired but reachable:** `completionItem/resolve`, native `activation/activate`
(forceActivation/batch), the `objectCreation` 4-step pipeline, `objectGenerator`,
SRVB preview-URL/entity-set, `toggleVersion`.

**Out of scope for arc-1-lsp (→ arc-1):** classic object types, free SQL, git,
transport *release/delete*, debugger. These are the honest map of adt-ls's headless
limits — a feature of the comparison, not a defect to paper over with a hybrid.

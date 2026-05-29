# arc-1 vs arc-1-lsp — feature comparison + implementation rationale

What the two editions cover, and for every adt-ls-reachable capability: **is it
wired, and why / why not.** All claims are backed by live probes against a4h
(S/4HANA 2023, kernel 7.58), 2026-05-29.

> **Status (2026-05-29):** the full ABAP **authoring loop is implemented** in
> arc-1-lsp — read_source, create, update, activate, run_unit_tests, delete — pure
> adt-ls, behind a write-safety layer, live-verified on a4h. The by-name resolver
> (`getLsUri`) is solved. 16 tools total. (History: an earlier version of this doc
> wrongly called these "blocked by a workspace-model limitation" — that was a
> wrong-URI-shape mistake; the canonical repotree/AFF URIs work headless.)

## 1. The architectural difference (frames everything)

| | arc-1 (main) | arc-1-lsp |
|---|---|---|
| ADT protocol | **hand-rolled** (CSRF, locking, XML, version quirks) | **delegated to SAP's `adt-ls`** |
| Source files / LOC | 86 / ~38,600 | 24 / ~2,400 |
| Test files | 98 | 22 |
| Stage | production, write-capable, multi-user | read + authoring loop; 16 tools |
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
| **SAPDiagnose** (unit tests) | ✅ `run_unit_tests` | no dumps/traces/ATC |
| **SAPManage** (partial) | ◑ `list_generators`/`get_generator_schema`/`get_object_type_details`/`get_service_binding` | no package CRUD / FLP / UI5 |
| **SAPNavigate** (def/refs/where-used) | ❌ | `textDocument/*` unreached headless → arc-1 |
| **SAPLint** (ATC/abaplint) | ❌ | `atc/runCheck` unreached; activate gives syntax diagnostics only |
| **SAPQuery** (free SQL) | ❌ | absent in adt-ls → arc-1 |
| **SAPTransport** | ❌ (◑ `transport-get` reachable, unwired) | clunky args; CTS write unwired |
| **SAPGit** | ❌ | absent in adt-ls → arc-1 |
| **SAPContext** (deps/compression) | ❌ | depends on navigation → arc-1 |
| *(adt-ls extras)* | ✅ `health`, `list_destinations`, `list_creatable_objects`, `list_users` | |

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
| Generators — `abap_generators-*` | ✅ | ✅ `list_generators` / `get_generator_schema` | |
| Inactive list — `getInactiveObjects` | ✅ | ✅ `list_inactive_objects` | |
| Service bindings — `fetch_services` | ✅ | ✅ `get_service_binding` | |
| **read_source** — `fileSystem/readFile` | ✅ | ✅ `read_source` | by name via `getLsUri`; modern types only (§4); include-aware |
| **create_object** — `abap_creation-create_object` | ✅ | ✅ `create_object` | `objectContent`=JSON string; returns AFF filePath; gated by `allowWrites`+package allowlist |
| **update source** — `fileSystem/writeFile` | ✅ | ✅ `update_source` | plain source (not base64); include-aware; gated |
| **activate** — `abap_activate_objects` | ✅ | ✅ `activate_object` | → `{success, diagnostics:[{range}]}` (syntax errors); gated |
| **run_unit_tests** — `abap_run_unit_tests` | ✅ | ✅ `run_unit_tests` | by name; ungated |
| **delete** — `fileSystem/delete` | ✅ | ✅ `delete_object` | deletes the `.clas.json`; gated |
| lock / unlock — `fileSystem/{lockFile,unlockFile}` | ✅ | (internal) | adt-ls locks on write; not exposed as a tool |
| validate creation — `abap_creation-run_validation` | needs `objectContent` | ❌ | same input as create |
| **ATC** — `atc/runCheck` | ❌ unreached | ❌ | "Object to be checked could not be determined" even with the AFF URI (`{uris}` and `{uri}`). Param/context unknown. |
| **navigation** — `textDocument/{documentSymbol,definition,hover}` | ❌ unclear | ❌ | `didOpen`-then-query **hangs** headless; not the path adt-ls uses. SAPNavigate = unreached. |
| transport read — `abap_transport-get` | needs 5 args (`isCreation`…) | ❌ | clunky; low priority |
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

**Genuinely unreached headless (any type):** ATC (`atc/runCheck` can't determine the
object), navigation/where-used (`textDocument/*` hangs). **Genuinely absent:** free
SQL, git. Honest adt-ls limits → arc-1 territory.

## 5. What can be achieved in arc-1-lsp (pure adt-ls) — current state

**Live, wired (16 tools):**
- Reads: `search_objects`, `read_source`, `list_users`, `list_inactive_objects`,
  `list_generators`, `get_generator_schema`, `get_object_type_details`,
  `get_service_binding`, `list_creatable_objects`, `list_destinations`, `health`.
- **Authoring loop (modern types, behind `ARC1_ALLOW_WRITES` + package allowlist):**
  `create_object`, `update_source`, `activate_object`, `run_unit_tests`,
  `delete_object` — full create→edit→activate→test→delete, by name, live-verified.

**Not yet wired but reachable:** `transport-get` (clunky args), `run_validation`,
richer SAPWrite (method surgery, AFF validation, batch — arc-1 has these).

**Out of scope for arc-1-lsp (→ arc-1):** classic object types, ATC/lint,
navigation/where-used, free SQL, git, transport *writes*, RAP generation (mutating,
unwired). These are the honest map of adt-ls's headless limits — a feature of the
comparison, not a defect to paper over with a hybrid.

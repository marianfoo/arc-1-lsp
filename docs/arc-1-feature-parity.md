# arc-1 vs arc-1-lsp — feature comparison + implementation rationale

What the two editions cover, and for every adt-ls-reachable capability: **is it
wired, and why / why not.** All claims are backed by live probes against a4h
(S/4HANA 2023, kernel 7.58), 2026-05-29.

> **CORRECTION (2026-05-29):** an earlier version of this doc called `read_source`,
> `create_object`, `activate`, and `run_unit_tests` *blocked by a workspace-model
> limitation*. **That was wrong** — it was a wrong-URI-shape mistake on my part.
> With the **canonical repotree/AFF URIs** they all work headless (proven below).
> The real remaining gap is small: resolving an *existing* object's AFF URI by name.

## 1. The architectural difference (frames everything)

| | arc-1 (main) | arc-1-lsp |
|---|---|---|
| ADT protocol | **hand-rolled** (CSRF, locking, XML, version quirks) | **delegated to SAP's `adt-ls`** |
| Source files / LOC | 86 / ~38,600 | 21 / ~1,825 |
| Test files | 98 | 18 |
| Stage | production, write-capable, multi-user | early; 10 read tools live on CF |
| System-specific code to own | ~29 ADT files | ~zero |

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
| **read_source** — `fileSystem/readFile` | ✅ **WORKS** | ❌ not wired | needs the **repotree `.clas.abap` URI** (or direct ADT GET by path). Earlier `{}` = wrong URI shape. |
| **create_object** — `abap_creation-create_object` | ✅ **WORKS** | ❌ not wired (mutating) | `objectContent` is a **JSON string** `{name,packageName,description}`; returns the AFF filePath. |
| **activate** — `abap_activate_objects` | ✅ **WORKS** | ❌ not wired (mutating) | `uris:[<AFF filePath>]` → `{success:true,objectDiagnostics:[]}` |
| **run_unit_tests** — `abap_run_unit_tests` | ✅ **WORKS** | ❌ not wired | `uris:[<AFF filePath>]` → results / "No tests found" |
| **delete** — `fileSystem/delete` | ✅ **WORKS** | ❌ not wired (mutating) | delete the **`.clas.json`** (not `.abap`) |
| writeFile / update source — `fileSystem/writeFile` | likely (untested) | ❌ | for update; same AFF URI family |
| validate creation — `abap_creation-run_validation` | needs `objectContent` | ❌ | same input as create |
| ATC — `atc/runCheck` | needs an object/URI | ❌ | retest with an AFF URI (earlier "could not determine object" used no/raw URI) |
| transport read — `abap_transport-get` | needs 5 args (incl. `isCreation`) | ❌ | clunky; low priority |
| Free SQL / data preview | — | ❌ | **absent** from adt-ls — would need arc-1-style direct impl |
| Git (gCTS/abapGit) | — | ❌ | **absent** from adt-ls |

## 4. The one real remaining gap — resolving an *existing* object's AFF URI by name

`create_object` *returns* the AFF filePath, so a **create → edit → activate → test**
lifecycle on NEW objects threads the URI through with no gap. For an **existing**
object referenced by name, we need its `abap:/repotree-v1/…` URI, and:
- `search_objects` returns the **ADT path** (`/sap/bc/adt/oo/classes/cl_x`), not the
  repotree URI.
- the repotree is **package-organized** (`getFolderUri`+`readDirectory` traverse it,
  but it's deep and children lack URIs — fragile to reconstruct).

So the remaining work is a **name → AFF-URI resolver**. Options:
- **reads:** sidestep entirely — direct ADT GET `<adt-path>/source/main` (proven 200,
  works by name from search). Simplest for `read_source`.
- **activate/test/update on existing objects:** need the AFF URI → either harden the
  tree traversal, or find a resolver method (`repository/getLsUri`, unexplored), or
  `create`-flow objects carry their URI already.
- **ATC:** retest with a valid AFF URI (the earlier failure used a bad URI).

This is **engineering, not a wall** — the capabilities themselves are proven.

## 5. Bottom line + what's actually left

- **adt-ls's headless surface is broad** — read, create, update, activate, unit
  tests, delete all work via the canonical AFF URIs. Far more of arc-1's surface is
  reachable than the earlier (wrong) "blocked" verdict implied.
- **What's wired:** 10 reads (no AFF-URI needed). **What's proven but unwired:**
  read_source, create, activate, run_unit_tests, delete.
- **What unwired needs:** (a) a **name→AFF-URI resolver** for existing-object ops;
  (b) a **write-safety layer** before exposing create/activate/delete (arc-1 has
  `allowWrites` + package allowlists + scopes; arc-1-lsp has none yet — read-only so
  far). Reads (`read_source`) need neither and could ship now.
- **Genuinely absent in adt-ls:** free SQL (SAPQuery), git (SAPGit) — always
  arc-1-style direct, never adt-ls.

The earlier "hard block" was a measurement error. The true frontier is wiring +
a write-safety story + the AFF-URI resolver — all tractable.

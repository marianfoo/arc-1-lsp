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
| **read_source** — `fileSystem/readFile` | ✅ **WORKS** | ❌ not wired | repotree `.clas.abap` URI → source. (Direct-GET shortcut REJECTED — no hybrid, ADR-0003.) |
| **create_object** — `abap_creation-create_object` | ✅ **WORKS** | ❌ not wired (mutating) | `objectContent` = **JSON string** `{name,packageName,description}`; returns the AFF filePath. |
| **update source** — `fileSystem/writeFile` | ✅ **WORKS** | ❌ not wired (mutating) | `{uri, content: <plain multi-line source>}` → null. (base64 fails: ABAP 255-char/line limit.) |
| **activate** — `abap_activate_objects` | ✅ **WORKS** | ❌ not wired (mutating) | `uris:[<AFF filePath>]` → `{success:true,objectDiagnostics:[]}` |
| **run_unit_tests** — `abap_run_unit_tests` | ✅ **WORKS** | ❌ not wired | `uris:[<AFF filePath>]` → results / "No tests found" |
| **lock / unlock** — `fileSystem/{lockFile,unlockFile,getFileLockStatus}` | ✅ **WORKS** | ❌ (internal) | `{operationExecuted:true}` — for safe edits |
| **delete** — `fileSystem/delete` | ✅ **WORKS** | ❌ not wired (mutating) | delete the **`.clas.json`** (not `.abap`) |
| validate creation — `abap_creation-run_validation` | needs `objectContent` | ❌ | same input as create |
| **ATC** — `atc/runCheck` | ❌ unreached | ❌ | "Object to be checked could not be determined" even with the AFF URI (`{uris}` and `{uri}`). Param/context unknown. |
| **navigation** — `textDocument/{documentSymbol,definition,hover}` | ❌ unclear | ❌ | `didOpen`-then-query **hangs** headless; not the path adt-ls uses. SAPNavigate = unreached. |
| transport read — `abap_transport-get` | needs 5 args (`isCreation`…) | ❌ | clunky; low priority |
| Free SQL / data preview | — | ❌ | **absent** from adt-ls |
| Git (gCTS/abapGit) | — | ❌ | **absent** from adt-ls |

## 4. The pure-adt-ls boundary (no hybrid — ADR-0003)

arc-1-lsp uses adt-ls **only** — no direct HTTP ADT, even for an easy win. Two
consequences for the proven-but-unwired capabilities:

**Create-flow needs nothing extra.** `create_object` *returns* the AFF filePath, so
**create → write source → lock → activate → run tests → delete** on objects
arc-1-lsp creates threads the URI through with **no resolver and no hybrid** — fully
in-bounds, works today. This is the sweet spot.

**Operating on EXISTING objects by name needs a pure resolver.** `readFile`/`writeFile`/
`activate` all need the `abap:/repotree-v1/…` AFF URI, but `search_objects` returns
an **ADT path** (`/sap/bc/adt/oo/classes/cl_x`), and the repotree is package-organized
(deep; `readDirectory` children lack URIs; encoding is exact → fragile). So a
**name→AFF-URI resolver** (pure adt-ls tree walk, or an unexplored `repository/getLsUri`)
is the gate. The direct-ADT-GET shortcut that would trivially solve reads is
**deliberately rejected** (it'd make this a hybrid). If the resolver proves too
flaky, by-name source reads are simply **arc-1's job, not this edition's.**

**Genuinely unreached headless:** ATC (`atc/runCheck` can't determine the object),
navigation/where-used (`textDocument/*` hangs). **Genuinely absent:** free SQL, git.
These are honest adt-ls limitations → arc-1 territory.

## 5. What can be achieved in arc-1-lsp (pure adt-ls)

**Now (10 tools, live):** all destination-scoped reads — search, users, generators,
creatable types, object-type fields, service bindings, inactive list.

**Achievable, proven, unwired — the full object lifecycle:** `read_source`,
`create`, `update`/`write`, `activate`, `run_unit_tests`, `delete` (+ locking).
Gated by two enablers:
1. a **write-safety layer** (arc-1 has `allowWrites` + package allowlist + scopes;
   arc-1-lsp has none — needed before any mutating tool);
2. for *existing* objects, the **name→AFF-URI resolver** (create-flow objects don't
   need it).

So the realistic next milestone is an **agent-driven authoring loop** — create a
class/program, write its source, activate, run its tests — which is 100% pure
adt-ls and needs only the write-safety layer. Reading/editing *arbitrary existing*
objects additionally needs the resolver.

**Out of scope for arc-1-lsp (→ arc-1):** ATC/lint, where-used/navigation, free SQL,
git, and cheap by-name source browsing if the resolver doesn't pan out. These gaps
are the honest map of adt-ls's headless limits — a feature of the comparison, not a
defect to paper over with a hybrid.

# Plan 07 — Wire the reachable adt-ls tools (generators, transport, validation)

## Goal

adt-ls federates **14 MCP tools**; arc-1-lsp wires 9. This plan wires the **5
reachable-but-unwired** ones and closes the **create-without-transport** gap, so
the full adt-ls authoring + generation surface is available behind the existing
write-safety model. Pure adt-ls (ADR-0003); no new SAP protocol.

## Authoritative tool surface (dumped live from adt-ls `tools/list`, 2026-06-01)

The exact backend names + input schemas (no SAP backend needed to list):

| Backend tool | Wired? | Required args |
|---|---|---|
| `abap_business_services-fetch_services` | ✅ `get_service_binding` | serviceBindingName, destination |
| `abap_business_services-fetch_service_information` | ❌ **wire** | serviceBindingName, serviceName, serviceDefinition, serviceVersion, odataInfoUri, odataVersion, destination |
| `abap_activate_objects` | ✅ `activate_object` | uris[] (max 15) |
| `abap_run_unit_tests` | ✅ `run_unit_tests` | uris[] |
| `abap_creation-get_all_creatable_objects` | ✅ `list_creatable_objects` | destination |
| `abap_creation-get_object_type_details` | ✅ `get_object_type_details` | objectType, destination |
| `abap_creation-run_validation` | ❌ **wire** | destination, objectType, objectContent |
| `abap_creation-create_object` | ✅ `create_object` | destination, objectType, objectContent, **transportRequestNumber** |
| `abap_list_destinations` | ✅ `list_destinations` | — |
| `abap_generators-list_generators` | ✅ `list_generators` | destination |
| `abap_generators-get_schema` | ✅ `get_generator_schema` | destination, generatorId, packageName, referencedObjectType, referencedObjectName |
| `abap_generators-generate_objects` | ❌ **wire** | destination, generatorId, content, packageName, transportRequestNumber, referencedObjectType, referencedObjectName |
| `abap_transport-create` | ❌ **wire** | destination, developmentPackage, transportDescription, isCreation (objectName/objectType optional) |
| `abap_transport-get` | ❌ **wire** | destination, objectName, objectType, developmentPackage, isCreation |

### The create_object transport gap (latent bug + feature)

`create_object`'s schema marks `transportRequestNumber` **required** (`""` for
local/$TMP), as a **top-level arg** (peer of `objectType`/`objectContent`, NOT
inside the `objectContent` JSON — that JSON stays `{name, packageName,
description}`). `lifecycle.createObject` currently omits it — $TMP tolerates the
absence (smoke-test proven), but (a) a stricter adt-ls release could reject it,
and (b) **transportable packages cannot be targeted** without a real TR.

This chain is **adt-ls's own documented workflow**, stated in the dumped tool
descriptions (not invented here): `get_all_creatable_objects → get_object_type_details
→ run_validation → create_object` (create desc: *"If transport is required then
run the ABAP transport tools … You MUST call abap_transport-get"*); and for
generation `list-generators → get-schema → generate-objects`, where get_schema's
desc says *"After getting schema, call abap_transport-get … (skip only if package
is '$TMP')"*.

## Design decisions

1. **Mutations through `lifecycle`, reads through `server.ts` callTool** — matches
   the existing split. New lifecycle methods: `generateObjects`, `createTransport`
   (gated); `validateObject`, `findTransport` (reads; in lifecycle to reuse the
   private `dest()` closure + objectContent building). `get_service_details` is a
   pure passthrough → `server.ts` callTool (like `get_service_binding`).
2. **New safety flag `allowTransportWrites`** (mirrors arc-1's ceiling): default
   `false`; `create_transport` requires `allowWrites=true` **and**
   `allowTransportWrites=true`. **Implemented by extending `assertWriteAllowed`**
   with an optional `requireTransportWrites?: boolean` — NOT a parallel function
   (avoids drift of the allowWrites+package logic). `find_transport` is a read
   (ungated). `generate_objects` is gated by `allowWrites` + package allowlist.
3. **`create_object`/`generate_objects` take an optional `transport`** → forwarded
   as the **top-level** `transportRequestNumber` (default `''`). Enables non-$TMP
   packages and fixes the latent contract gap.
4. **No transport release/delete** — out of scope (higher-stakes; arc-1's domain).
   We only *find* and *create* TRs as part of the write flow.
5. **Error detection depends on `isError`** — `parseFederated` sets `ok=!isError`.
   `generateObjects`/`createTransport` throw on `!ok`; a known-bad-input smoke test
   asserts a failure actually surfaces (guards the assumption that adt-ls sets
   `isError`, not just an error string in `content`).

## Tool naming (snake_case, consistent with existing surface)

- `generate_objects` ← `abap_generators-generate_objects`
- `validate_object` ← `abap_creation-run_validation`
- `find_transport` ← `abap_transport-get` — **object-scoped** (returns the TR(s)
  relevant to creating/changing *one* object; NOT a system transport list, so not
  `list_transports`)
- `create_transport` ← `abap_transport-create`
- `get_service_details` ← `abap_business_services-fetch_service_information`
  (drills into one OData service for URL/entity-sets; its 7 args come from
  `get_service_binding`'s output — documented in the tool description)

Result: **21 tools** (16 → 21).

## Tasks

### Task 1 — Commit the verified schemas (evidence first)
The 5 backend schemas were dumped live from `adt-ls 1.0.0.202605281240` via
`tools/list` (no SAP needed). Per the reference doc's own rule, **record them
before coding** so unit tests assert against committed truth, not memory.
- `docs/adt-ls-reference.md` §2: flip `run_validation`/`transport-get` ◐→✅; add
  rows for `generate_objects`, `transport-create`, `fetch_service_information`
  **with their exact arg lists**; add the documented workflow chain (from the tool
  descriptions). Update §8 wired-tools list.

### Task 2 — Safety: `allowTransportWrites`
- `src/server/safety.ts`: add `allowTransportWrites: boolean` to `WriteSafety`;
  extend `assertWriteAllowed(safety, {action, packageName?, requireTransportWrites?})`
  — when `requireTransportWrites`, also require `allowTransportWrites` (after the
  `allowWrites` check, before/with the package check).
- `src/server/config.ts`: parse `ARC1_ALLOW_TRANSPORT_WRITES` / `--allow-transport-writes`
  (default false) into `Arc1LspConfig`.
- `src/server/engine.ts`: add `allowTransportWrites` to the inline `safety` literal
  (line ~188) — the only `WriteSafety` construction site.
- Tests (**extend existing files**): `tests/unit/server/safety.test.ts` — full
  matrix: writes off → throws; writes on + transport off + `requireTransportWrites`
  → throws; both on + package disallowed → throws; both on + allowed → passes.
  `config.test.ts` — flag/env/default for the new var.

### Task 3 — Lifecycle methods
- `src/adt-ls/lifecycle.ts`:
  - `createObject`: add optional `transportRequestNumber` (default `''`) as a
    **top-level** call arg (objectContent JSON unchanged: `{name,packageName,description}`).
  - `generateObjects({generatorId, content, packageName, transportRequestNumber?, referencedObjectType?, referencedObjectName?})`:
    `assertWriteAllowed({action:'generate_objects', packageName})`, call
    `abap_generators-generate_objects` (refs default `''`, transport default `''`),
    parse, throw on `!ok`.
  - `validateObject({objectType, name, packageName, description})`: build the same
    objectContent JSON as create, call `abap_creation-run_validation`, return parsed.
  - `findTransport({objectName, objectType, developmentPackage, isCreation})`: read,
    call `abap_transport-get`, return parsed.
  - `createTransport({developmentPackage, transportDescription, isCreation, objectName?, objectType?})`:
    `assertWriteAllowed({action:'create_transport', packageName: developmentPackage, requireTransportWrites:true})`,
    call `abap_transport-create`, return parsed (the new TR number).
- Tests (**extend `tests/unit/adt-ls/lifecycle.test.ts`**): gating (writes off →
  throws; create_transport with transport-writes off → throws); exact backend tool
  name + arg shape via the fake `callTool`; `createObject` default `transportRequestNumber:''`
  and explicit pass-through (the existing test asserts the *objectContent* shape —
  add a top-level-arg assertion).

### Task 4 — Register the 5 tools in `server.ts`
- `generate_objects`, `validate_object`, `find_transport`, `create_transport`
  → via `engine.lifecycle.*`. `get_service_details` →
  `engine.callTool('abap_business_services-fetch_service_information', …)`.
- Each: destination-bound check → clear error otherwise (match existing pattern).
- **Prerequisites in `tests/unit/server/server.test.ts`** (the review flagged these
  as hard blockers): (a) the `fakeEngine.lifecycle` stub MUST gain
  `generateObjects/validateObject/findTransport/createTransport` or every server
  test throws; (b) the `registers exactly the foundation tools` guard's sorted
  name array MUST be updated to all 21 names.
- Tests: per-tool passthrough mirrors the existing `get_service_binding` test
  (assert exact backend tool name + exact arg object) + destination-missing path.

### Task 5 — Gated live verification (conservative; no orphans)
- `tests/unit/adt-ls/*.smoke.test.ts` (skips without `ARC1_TEST_SAP_PASSWORD`) —
  **exploratory**: assert the call *resolves*, then capture the real response shape
  into the reference doc (these endpoints were never run live before):
  - `validate_object` for a CLAS in `$TMP`; also assert a known-bad input surfaces
    as an error (guards the `isError` assumption).
  - `find_transport` for a `$TMP` object with `isCreation:true`.
- **`generate_objects` live is DEFERRED** (a generator scaffolds a *full* RAP
  service — table+CDS+BDEF+SRVD+SRVB — cleanup is multi-object/brittle). Verify
  wiring via unit tests + one manual `$TMP` run during review; no auto-mutating
  generate smoke test (would risk orphans — reference §6 gotcha).

### Task 6 — Docs
- `docs/arc-1-feature-parity.md`: SAPManage/SAPTransport rows; tool count 16→21.
- `README.md`: tool list + the transport/write flow note; `ARC1_ALLOW_TRANSPORT_WRITES`
  config row.
- `CLAUDE.md`: "Key Files for Common Tasks" — add a generate/transport row.
- (Reference-doc edits already done in Task 1.)

## Validation
- `npm run build` · `npm run typecheck` · `npm run lint` · `npm test`
- Gated (local, with `ARC1_TEST_SAP_PASSWORD`): validate/find_transport smoke tests
  + one manual `generate_objects` $TMP run (review only).

## Out of scope (→ later / arc-1)
- Transport release/delete; method-level surgery; AFF schema validation; batch.
- Per-key scopes/audit (W2/W4).

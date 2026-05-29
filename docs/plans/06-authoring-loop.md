# Authoring loop — read/create/update/activate/test/delete (pure adt-ls)

## Overview
Wire the proven, reachable adt-ls lifecycle into MCP tools, behind a write-safety
layer. All pure adt-ls (ADR-0003). Supported object types only (modern ABAP-Cloud —
CLAS/INTF/DDLS/DCLS/SRVB/DDLX/BDEF/SRVD); classic types return adt-ls's "use Eclipse"
placeholder → surfaced as a clear error. Capability evidence: `docs/adt-ls-reference.md`.

## Tools (6)
| Tool | adt-ls calls | Mutating? |
|---|---|---|
| `read_source` `{name, objectType, include?}` | resolve → `fileSystem/readFile` | no |
| `create_object` `{objectType, name, package, description}` | `abap_creation-create_object` | yes |
| `update_source` `{name, objectType, source, include?}` | resolve → `fileSystem/writeFile` | yes |
| `activate_object` `{name, objectType}` | resolve → `abap_activate_objects` → diagnostics | yes |
| `run_unit_tests` `{name, objectType}` | resolve → `abap_run_unit_tests` | no |
| `delete_object` `{name, objectType}` | resolve → `fileSystem/delete` (.json) | yes |

**Resolver** (`resolveAffUri`): `search_objects(name, types:[objectType])` → exact-name
ADT path → `repository/getLsUri{destination,adtUri}` → repotree AFF URI. `include`
swaps `…clas.abap` → `…clas.<include>.abap`. delete derives the `.json` (final ext → json).

## Write-safety layer (new — arc-1-lsp has none yet)
- `ARC1_ALLOW_WRITES` (default **false**) — gates create/update/activate/delete.
- `ARC1_ALLOWED_PACKAGES` (default **`$TMP`**) — checked on `create` (exact / `PREFIX*` / `*`).
- read_source + run_unit_tests are ungated (non-mutating).
- `src/server/safety.ts`: `assertWriteAllowed(safety, {action, packageName?})`.

## Key files
- `src/server/config.ts` — `allowWrites`, `allowedPackages`.
- `src/server/safety.ts` — NEW.
- `src/adt-ls/repository.ts` — `getLsUri`, `readFile`, `writeFile`, `deleteObject`, AFF-URI helpers.
- `src/adt-ls/lifecycle.ts` (or engine) — `resolveAffUri` + the 6 ops + activate-diagnostics shape.
- `src/server/engine.ts` — expose lifecycle methods (close over driver/destination/safety).
- `src/server/server.ts` — register the 6 tools.
- Tests: `tests/unit/server/{server,safety,config}.test.ts`, `tests/unit/adt-ls/repository.test.ts`,
  gated `tests/unit/adt-ls/lifecycle.smoke.test.ts` (full create→read→update→activate→test→delete in `$TMP`).

## Tasks (loop per tool, but shared infra first)
1. Safety layer (config + safety.ts + tests).
2. Resolver + AFF helpers in repository.ts (getLsUri/readFile/writeFile/delete + tests).
3. Engine lifecycle methods + the 6 server tools.
4. Unit tests (mock engine/driver): each tool's delegation, the no-write-allowed path,
   classic-type "use Eclipse" detection, include filename transform.
5. Gated live lifecycle test (a4h $TMP, full loop + cleanup; skips without creds).
6. Review: build/typecheck/lint/test; deploy; update feature-parity + reference docs.

## Validation
`npm run build` · `npm test` · `npm run typecheck` · `npm run lint` · gated live lifecycle.

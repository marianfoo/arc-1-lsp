# Read-tools expansion — more read-only tools backed by adt-ls

**STATUS: DONE (2026-05-29).** Added `list_users`, `list_generators`,
`get_generator_schema`, `get_object_type_details` (9 read tools total). 97 tests
(96 + 1 gated live, all green); live-verified on a4h. Hard blocker confirmed:
source/object-document reads (`read_source`, where-used, documentSymbol, table
data) remain blocked by the workspace/tree model — see `docs/adt-ls-tool-surface.md`.

## Overview

Add the read-only tools that live-research (2026-05-29, vs a4h) proved reachable
headless, beyond the existing `search_objects` / `list_creatable_objects` /
`list_inactive_objects`. Source-dependent reads (`read_source`, where-used,
documentSymbol, table data) remain blocked by the workspace/tree model (see
`docs/adt-ls-tool-surface.md`) — that's the hard boundary for this round.

## Context

### Research verdict (what works with simple args)
| Tool | Backing | Args | Result |
|------|---------|------|--------|
| `list_users` | LSP `adtLs/repository/getUsers` | `{destination}` | `{users:[{id,text}]}` ✅ |
| `list_generators` | federated `abap_generators-list_generators` | `{destination}` | `{generators:[{title,description,…}]}` ✅ |
| `get_generator_schema` | federated `abap_generators-get_schema` | `{destination, generatorId}` | schema ✅ (chained off list) |
| `get_object_type_details` | federated `abap_creation-get_object_type_details` | `{destination, objectType, name}` | `{fields:[…]}` (creation metadata) ✅ |

### Blocked (this round's hard blocker — all need source/object-document context)
- `read_source` (readFile — workspace model), `textDocument/references` &
  `documentSymbol` (need an open doc), `atc/getCheckVariants` (needs an object),
  `cts/transport/searchTransports` (Internal error), table/data preview (no method).
- Partial (need clunky required args, deferred): `abap_transport-get`
  (developmentPackage+objectName+objectType), `business_services-fetch_services`
  (serviceBindingName).

### Key files
- `src/adt-ls/repository.ts` — add `getUsers` wrapper + `UserRef`.
- `src/server/engine.ts` — add `listUsers()` (close over connectedDestination).
- `src/server/server.ts` — register the 4 tools (federated ones via `callTool`,
  defaulting `destination` to the connected one).
- Tests: `tests/unit/server/server.test.ts`, `tests/unit/adt-ls/repository.test.ts`,
  `tests/unit/adt-ls/logon.smoke.test.ts` (live).

## Tasks

1. `getUsers` wrapper + `UserRef` in `repository.ts`; `engine.listUsers()`.
2. Register `list_users`, `list_generators`, `get_generator_schema`,
   `get_object_type_details` in `server.ts` (destination defaults to the connected
   one; clear error when none).
3. Unit tests: repository `getUsers` payload; server delegation + no-destination
   path for each tool.
4. Live (gated): `list_users` returns DEVELOPER; `list_generators` returns ≥1.
5. Review: `npm test`/`typecheck`/`lint`; deploy to CF; verify `tools/list` = 9.

## Validation
`npm run build` · `npm test` · `npm run typecheck` · `npm run lint` · gated live.

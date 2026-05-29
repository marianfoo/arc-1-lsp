# Containerize — BYO linux adt-ls + http-streamable transport

## Overview

Package arc-1-lsp + a developer-provided **linux-x64 adt-ls** into a Docker
image that runs headless and serves MCP over **http-streamable** (required for
BTP Cloud Foundry, which can't `npx` a JVM). The image is built locally/in CI
and pushed to the admin's registry — arc-1-lsp's repo never contains SAP
binaries (the linux adt-ls is injected at build time from `vendor/adt-ls/`,
which is gitignored).

This plan delivers a locally-runnable `linux/amd64` container that an MCP client
can reach over HTTP with an API key, with the embedded adt-ls booting inside the
container. It does NOT deploy to CF (that's plan 03) — but it produces the exact
image that plan 03 pushes.

## Context

### Current State
- Foundation complete (plan 01): engine boots a real adt-ls headless on macOS;
  stdio transport works; `health` + `list_destinations` federate.
- `http-streamable` transport is intentionally unimplemented (foundation exits
  with a message). No Dockerfile yet. `vendor/adt-ls/` holds the linux binary
  (downloaded VSIX, extracted).

### Target State
- `docker build --platform linux/amd64` produces an image that, when run,
  boots adt-ls headless and serves MCP at `http://<host>:8080/mcp` behind an
  API-key check.
- A local `docker run` smoke confirms an MCP client can `initialize` +
  `tools/list` + call `health` through the container.

### Key Files

| File | Role |
|------|------|
| `scripts/extract-adt-ls.mjs` | unzip the linux VSIX → `vendor/adt-ls/` |
| `src/server/http.ts` | http-streamable transport + API-key auth (edge) |
| `src/server/config.ts` | add `ARC1_API_KEYS` |
| `src/index.ts` | wire http-streamable when `ARC1_TRANSPORT=http-streamable` |
| `Dockerfile` | node:22-slim (Debian) + adt-ls native deps + vendor/adt-ls + dist |
| `.dockerignore` | exclude node_modules cache, tests, docs |
| `scripts/docker-build.sh` | buildx `--platform linux/amd64` |
| `tests/unit/server/http.test.ts` | API-key auth unit tests |

### Design Principles
- **adt-ls native deps are empirical.** The headless Eclipse/SWT stack may need
  system libs (fontconfig, libfreetype, libgtk, libxtst, …). Start minimal; add
  packages as startup errors reveal them. Document the final set.
- **Image is self-contained.** CF runs the image directly (no buildpack) — adt-ls
  + its bundled JRE + Node + dist + node_modules all inside.
- **No SAP binary in git or in the published base.** Injected at build from
  `vendor/adt-ls/`; image is pushed to the admin's private registry only.
- **Edge auth = API key for v1** (`ARC1_API_KEYS`); XSUAA is a later plan.
- **amd64 target.** Build with buildx `--platform linux/amd64` (CF stack).

## Development Approach

Implement transport + auth in TS first (testable on macOS), then the extract
script, then the Dockerfile, iterating on native deps via `docker run` until
adt-ls initializes inside the container. Keep adt-ls-dependent tests skip-gated.

## Validation Commands

- `npm run build`
- `npm test`
- `npm run typecheck`
- `npm run lint`

### Task 1: Extract the linux adt-ls from the VSIX

**Files:**
- Create: `scripts/extract-adt-ls.mjs`

A VSIX is a zip; the binary lives at `extension/adt-ls/linux/gtk/x86_64/adt-ls`.

- [ ] Script unzips `vendor/adt-vscode-linux-x64.vsix`, copies its
  `extension/adt-ls/` tree to `vendor/adt-ls/` (so
  `vendor/adt-ls/linux/gtk/x86_64/adt-ls` exists), and `chmod +x` the binary.
- [ ] Idempotent; clear error if the VSIX is missing.
- [ ] Run it; verify `vendor/adt-ls/linux/gtk/x86_64/adt-ls` exists and is
  executable. (No unit test — it's a build helper; verify by running.)

### Task 2: API-key edge auth + config

**Files:**
- Modify: `src/server/config.ts`
- Create: `src/server/auth.ts`, `tests/unit/server/auth.test.ts`

Add `ARC1_API_KEYS` (comma-separated `key` or `key:label`) to config. `auth.ts`
exposes `checkApiKey(headerValue, configuredKeys)` → boolean, accepting
`Authorization: Bearer <key>` or `x-api-key: <key>`. Empty config = auth
disabled (local dev) with a startup warning.

- [ ] `parseApiKeys(raw)` and `checkApiKey(header, keys)` pure functions.
- [ ] Add unit tests (~6 tests): bearer + x-api-key accepted; unknown rejected;
  empty config disables; label parsing.
- [ ] Run `npm test` — all pass.

### Task 3: http-streamable transport

**Files:**
- Create: `src/server/http.ts`
- Modify: `src/index.ts`
- Create: `tests/unit/server/http.test.ts`

Implement an HTTP server (node `http`) mounting the MCP SDK
`StreamableHTTPServerTransport` at `/mcp`, gated by the API-key check, plus a
`GET /healthz` (no auth) for CF health checks. Wire it in `src/index.ts` when
`ARC1_TRANSPORT=http-streamable`. Bind `0.0.0.0:${ARC1_PORT}`.

- [ ] `startHttpServer(server, config)` returns the listening http.Server.
- [ ] `401` without/with-bad key on `/mcp`; `200` on `/healthz`.
- [ ] Add unit tests (~5 tests): `/healthz` ok; `/mcp` rejects missing/bad key;
  accepts a valid key (handshake reaches the transport). Use a mock MCP server.
- [ ] Run `npm test` — all pass.

### Task 4: Dockerfile + .dockerignore

**Files:**
- Create: `Dockerfile`, `.dockerignore`

Multi-stage: build stage (`node:22` → `npm ci` + `npm run build`); runtime stage
(`node:22-slim`) copying `dist/`, production `node_modules/`, and
`vendor/adt-ls/`. Install adt-ls's native deps via apt (start with
`fontconfig libfreetype6 libgtk-3-0 libxtst6 ca-certificates`; refine in Task 5).
`ENV ARC1_TRANSPORT=http-streamable ARC1_ADT_LS_PATH=/app/vendor/adt-ls/linux/gtk/x86_64/adt-ls`.
`EXPOSE 8080`. `ENTRYPOINT ["node","dist/index.js"]`.

- [ ] `.dockerignore` excludes `node_modules`, `tests`, `docs`, `*.vsix`, `.git`.
- [ ] Dockerfile builds (verified in Task 5).

### Task 5: Build amd64 image + local container smoke

**Files:**
- Create: `scripts/docker-build.sh`

- [ ] `docker buildx build --platform linux/amd64 -t arc-1-lsp:dev --load .`
  succeeds (iterate native deps until adt-ls starts inside the container).
- [ ] `docker run -e ARC1_API_KEYS=devkey -p 8080:8080 arc-1-lsp:dev` boots;
  adt-ls initializes inside (check logs).
- [ ] Manual MCP smoke: `curl` `initialize` + `tools/list` against
  `http://localhost:8080/mcp` with `Authorization: Bearer devkey` returns the
  federated tools; `health` reports `up:true`. Document the final apt dep set.
- [ ] Confirm `/healthz` returns 200 without auth.

### Task 6: Docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `docs/native-deps.md`

- [ ] README: docker build/run instructions, the BYO-at-build-time model, the
  http-streamable + API-key usage.
- [ ] `docs/native-deps.md`: the final apt package list adt-ls needs on Debian
  slim + how it was determined.
- [ ] Run `npm run build` + `npm test` — green.

### Task 7: Final verification

- [ ] `npm test` — all pass; `npm run typecheck`; `npm run lint` — clean.
- [ ] `docker buildx build --platform linux/amd64` — succeeds.
- [ ] Container MCP smoke (initialize + tools/list + health) passes locally.
- [ ] No adt-ls orphan processes after container stop.
- [ ] Move this plan to `docs/plans/completed/`.

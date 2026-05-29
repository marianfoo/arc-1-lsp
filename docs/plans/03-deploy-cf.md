# Deploy to BTP Cloud Foundry

## Overview

Get arc-1-lsp running on BTP CF (us10 free-tier, org `Marian_Zeis_joule2`, space
`dev`) as a docker-image app: the linux/amd64 container boots the embedded
adt-ls and serves MCP over http-streamable behind an API key. Phase A (this
plan) proves the **stack on CF** — image pull, app start, route, health, and the
MCP `health`/`list_destinations` tools — *without* SAP connectivity yet. Phase B
(plan 04) adds the **Cloud-Connector bridge** so adt-ls can reach a4h via the
`SAP_TRIAL` destination.

Why split: a4h reachability from CF is the genuinely hard part (adt-ls doesn't
speak BTP Connectivity natively — it needs an arc-1-lsp forward-proxy that adds
the connectivity token and tunnels to a4h). Proving the CF deploy mechanics
first de-risks everything before that bridge.

## Context

### Current State
- Containerize complete (plan 02): `ghcr.io/marianfoo/arc-1-lsp:0.0.1`
  (linux/amd64) verified locally — boots adt-ls, full MCP chain, `$PORT` honored.
- CF infra GO: `diego_docker` enabled, quota 10G, route domain
  `cfapps.us10-001.hana.ondemand.com`.

### Target State (Phase A)
- `cf push` app `arc-1-lsp` from the ghcr image, 2G memory, http health check on
  `/healthz`, `ARC1_API_KEYS` set via `cf set-env` (not in manifest).
- The CF route serves `GET /healthz` (200) and `POST /mcp` (API-key gated);
  `health` reports adt-ls `up:true`; `list_destinations` returns empty (no
  destination bound yet — expected).

### Key Files

| File | Role |
|------|------|
| `manifest.yml` | CF app manifest (no secrets; docker image + health + memory) |
| `src/server/config.ts` | `$PORT` fallback so the app binds CF's assigned port |
| `Dockerfile` | no baked `ARC1_PORT`; adt-ls layer before dist for cache reuse |

### Design Principles
- **No secrets in git.** `ARC1_API_KEYS` and the docker pull password
  (`CF_DOCKER_PASSWORD`, currently the gh token) are passed at deploy time only.
- **Honor `$PORT`.** CF assigns the port; the app must listen on it.
- **Generous start timeout.** adt-ls (JVM/Eclipse) cold start precedes the http
  bind; `timeout: 180`.
- **Public image is the goal.** Until the ghcr package is flipped public (UI —
  no API for it), CF pulls with a token; then drop the docker username/password.

## Development Approach

Deploy via `cf push --no-start` → `cf set-env ARC1_API_KEYS` → `cf start`, then
verify the route. This plan is executed operationally (not via ralphex); it
records the steps and the verification.

## Validation Commands

- `npm run build`
- `npm test`
- `npm run lint`

### Task 1: Honor CF $PORT + manifest

**Files:**
- Modify: `src/server/config.ts`, `Dockerfile`
- Create: `manifest.yml`
- Modify: `tests/unit/server/config.test.ts`

- [ ] config `httpPort` falls back to `env.PORT` after `ARC1_PORT`.
- [ ] Dockerfile does not bake `ARC1_PORT`.
- [ ] `manifest.yml`: docker image, 2G memory + disk, http health `/healthz`,
  `timeout: 180`, `ARC1_TRANSPORT=http-streamable`.
- [ ] Add a config unit test for the `$PORT` fallback (ARC1_PORT still wins).
- [ ] Run `npm test` — all pass.

### Task 2: Push image + deploy

- [ ] `docker push ghcr.io/marianfoo/arc-1-lsp:0.0.1` (+ `:latest`).
- [ ] `CF_DOCKER_PASSWORD=$(gh auth token) cf push -f manifest.yml --no-start`.
- [ ] `cf set-env arc-1-lsp ARC1_API_KEYS <generated>`.
- [ ] `CF_DOCKER_PASSWORD=$(gh auth token) cf start arc-1-lsp`.

### Task 3: Verify on the CF route

- [ ] `GET https://<route>/healthz` → 200.
- [ ] `POST /mcp` without key → 401; with key → MCP `initialize` 200.
- [ ] `tools/call health` → adt-ls `up:true` (proves adt-ls boots in CF).
- [ ] `cf logs arc-1-lsp --recent` shows "registered 14 tools" + server ready.
- [ ] Record the route + note `list_destinations` empty (no destination yet).

### Task 4: Wrap up

- [ ] Update README with the CF deploy steps.
- [ ] Move this plan to `docs/plans/completed/`.
- [ ] Next: plan 04 — Cloud-Connector bridge for a4h via `SAP_TRIAL`.

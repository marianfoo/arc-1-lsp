# arc-1-lsp

An edition of **ARC-1** that delegates **all** ABAP/ADT interaction to SAP's
embedded **`adt-ls`** language server (the headless Eclipse ABAP LS bundled in
the `sapse.adt-vscode` VS Code extension) instead of a hand-rolled ADT HTTP
client. arc-1-lsp owns the MCP front-end, auth/scopes, and orchestration;
`adt-ls` owns CSRF, locking, XML, activation, transport — everything
system-specific.

```
agent (Claude / Copilot / Cursor)
   │  MCP (stdio today; http-streamable for CF deploy)
   ▼
arc-1-lsp  (Node/TS — discovers, spawns & supervises adt-ls; auth + scopes)
   ├─ LSP over pipe ───────────▶ adt-ls (headless, BYO)   ← bootstrap + (later) language intelligence
   └─ HTTP localhost ─────────▶ adt-ls's own /mcp         ← federated tools
                                      │ RFC / HTTP (+ Cloud Connector on BTP)
                                      ▼  SAP ABAP backend
```

## Bring your own `adt-ls` (never redistributed)

arc-1-lsp ships **no** SAP binaries. It discovers a developer-provided `adt-ls`
in this order:
1. `ARC1_ADT_LS_PATH`
2. `vendor/adt-ls/<platform>/…` (build-time injection for containers)
3. the newest installed `sapse.adt-vscode-*` VS Code extension

Install the official **ABAP Development Tools for VS Code** extension (which
accepts SAP's Developer License) and arc-1-lsp will find its `adt-ls`.

## Run (stdio)

```bash
npm install
npm run build
node dist/index.js          # or: npm run dev
```

Point an MCP client at the process (stdio). Foundation tools: `health`,
`list_destinations`.

## Run (Docker / http-streamable)

The container bundles a **build-time-injected** linux adt-ls and serves MCP over
http-streamable behind an API key — this is the artifact deployed to BTP CF.

```bash
# stage the linux adt-ls (admin provides the licensed VSIX in vendor/)
node scripts/extract-adt-ls.mjs
# build the linux/amd64 image (host-builds dist; only prod deps + adt-ls are amd64)
IMAGE=arc-1-lsp:dev bash scripts/docker-build.sh
# run
docker run -e ARC1_API_KEYS=devkey -p 8080:8080 arc-1-lsp:dev
```

`GET /healthz` (no auth) for health checks; `POST /mcp` with
`Authorization: Bearer <key>` for MCP. Native deps: see `docs/native-deps.md`.

## Config (CLI > env > default)

| Env / flag | Default | Meaning |
|------------|---------|---------|
| `ARC1_ADT_LS_PATH` / `--adt-ls-path` | (discovered) | explicit adt-ls binary |
| `ARC1_ADT_LS_MCP_PORT` / `--adt-ls-mcp-port` | `2240` | port for adt-ls's own MCP server |
| `ARC1_ADT_LS_MCP_TOKEN` / `--adt-ls-mcp-token` | (generated) | bearer for adt-ls's MCP server |
| `ARC1_TRANSPORT` / `--transport` | `stdio` | `stdio` \| `http-streamable` (http lands in the deploy plan) |
| `ARC1_PORT` / `--port` | `8080` | HTTP port (http-streamable) |
| `ARC1_LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error` (stderr only) |

## Deploy to BTP Cloud Foundry

The image deploys to CF as a docker app (see `manifest.yml`). Secrets stay out of
git — the API key and the registry pull token are passed at deploy time:

```bash
docker push ghcr.io/marianfoo/arc-1-lsp:0.0.1
CF_DOCKER_PASSWORD=$(gh auth token) cf push -f manifest.yml --no-start
cf set-env arc-1-lsp ARC1_API_KEYS "$(openssl rand -hex 16)"
CF_DOCKER_PASSWORD=$(gh auth token) cf start arc-1-lsp
```

Live (us10 free-tier): `https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com`
— `/healthz` (200), `/mcp` (API-key gated). `health` confirms the embedded
adt-ls is up. `list_destinations` is empty until a destination is bound — the
Cloud-Connector bridge for a4h is the next milestone.

## Status & roadmap

Foundation (this milestone) is **green**: spawn adt-ls headless → start its MCP
over LSP → federate its 14 tools → expose a minimal arc-1-shaped MCP server.
Verified end-to-end locally on macOS against a real `adt-ls`.

Roadmap (see `docs/plans/`): containerize (BYO linux adt-ls) → deploy to BTP CF
(single technical user) → expand/curate tools → per-user principal propagation
via an auth-injecting proxy. The background research lives in the ARC-1 repo at
`docs/research/arc1-embedded-adt-ls-edition.md`.

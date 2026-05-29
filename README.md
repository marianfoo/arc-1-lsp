# arc-1-lsp

An edition of **ARC-1** that delegates **all** ABAP/ADT interaction to SAP's
embedded **`adt-ls`** language server (the headless Eclipse ABAP LS bundled in
the `sapse.adt-vscode` VS Code extension) instead of a hand-rolled ADT HTTP
client. arc-1-lsp owns the MCP front-end, auth/scopes, and orchestration;
`adt-ls` owns CSRF, locking, XML, activation, transport — everything
system-specific.

```
agent (Claude / Copilot / Cursor)
   │  MCP (stdio | http-streamable)
   ▼
arc-1-lsp  (Node/TS — discovers, spawns & supervises adt-ls; auth + scopes; owns SAP auth)
   ├─ LSP over pipe ───────────▶ adt-ls (headless, BYO)   ← bootstrap, destinations, logon, language intelligence
   └─ HTTP localhost ─────────▶ adt-ls's own /mcp         ← federated tools
                                      │ HTTPS
                                      ▼
                          TLS reverse proxy (CN=localhost, in arc-1-lsp)
                                      │  DIRECT ───────────────▶ SAP ABAP (internet-reachable)
                                      └  CC ─▶ connectivity bridge ─▶ BTP Connectivity ─▶ Cloud Connector ─▶ SAP ABAP
```

adt-ls requires an HTTPS backend and validates its hostname; SAP's default
self-signed cert (`CN=*.dummy.nodomain`) fails that. So arc-1-lsp runs a local
**TLS-terminating reverse proxy** (cert `CN=localhost`, trusted via a truststore
built from adt-ls's own JRE) and re-originates to the real backend — directly, or
through the connectivity bridge on BTP. Logon is **headless reentrance-ticket**
emulation (no browser). See `docs/adt-ls-headless-notes.md` + `docs/adr/`.

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

Point an MCP client at the process (stdio). **16 tools** — reads (`health`,
`list_destinations`, `list_creatable_objects`, `search_objects`,
`list_inactive_objects`, `list_users`, `list_generators`, `get_generator_schema`,
`get_object_type_details`, `get_service_binding`, `read_source`) and the **authoring
loop** (`create_object`, `update_source`, `activate_object`, `run_unit_tests`,
`delete_object`). The authoring/write tools cover **modern ABAP-Cloud object types**
(class/interface/CDS/…; classic types → use main ARC-1) and require
`ARC1_ALLOW_WRITES=true` + a package allowlist. Coverage vs main ARC-1 + why other
tools aren't wired: `docs/arc-1-feature-parity.md`. To auto-connect a SAP system on
startup, set the `ARC1_SAP_*` vars (see Config) — e.g. against an internet-reachable
system:

```bash
ARC1_SAP_HOST=a4h.marianzeis.de ARC1_SAP_PORT=50001 \
ARC1_SAP_USER=DEVELOPER ARC1_SAP_PASSWORD=… ARC1_SAP_DESTINATION=A4H \
node dist/index.js
```

`health` then reports `connectedDestination`, and `list_creatable_objects` returns
the system's object catalog.

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
| `ARC1_TRANSPORT` / `--transport` | `stdio` | `stdio` \| `http-streamable` |
| `ARC1_PORT` / `--port` | `8080` | HTTP port (http-streamable) |
| `ARC1_API_KEYS` / `--api-keys` | (none) | edge auth: `key[:label][,key2…]`; empty disables auth (local only) |
| `ARC1_ALLOW_WRITES` / `--allow-writes` | `false` | enable mutating tools (create/update/activate/delete) |
| `ARC1_ALLOWED_PACKAGES` / `--allowed-packages` | `$TMP` | packages writes may target — exact / `PREFIX*` / `*` |
| `ARC1_LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error` (stderr only) |
| **SAP connection — DIRECT mode** (internet-reachable backend) | | |
| `ARC1_SAP_HOST` / `--sap-host` | — | backend host (e.g. `a4h.marianzeis.de`) |
| `ARC1_SAP_PORT` / `--sap-port` | — | backend **HTTPS** port (e.g. `50001`) |
| `ARC1_SAP_USER` / `--sap-user` | — | SAP user (reentrance ticket is fetched with these creds) |
| `ARC1_SAP_PASSWORD` / `--sap-password` | — | SAP password (set via env / `cf set-env`, never committed) |
| `ARC1_SAP_DESTINATION` / `--sap-destination` | `SAP` | adt-ls destination id (DIRECT) **or** BTP destination name (CC) |
| `ARC1_SAP_CLIENT` / `--sap-client` | `001` | SAP client |
| `ARC1_SAP_INSECURE` / `--sap-insecure` | `true` | accept the backend's self-signed cert (backend TLS is ours) |
| **SAP connection — CC mode** (on-prem via Cloud Connector) | | |
| `ARC1_SAP_DESTINATION` | — | BTP Destination Service name; resolved when `connectivity` is bound |

All four DIRECT vars (`HOST`/`PORT`/`USER`/`PASSWORD`) must be set to auto-connect.
On BTP with a bound `connectivity` service, `ARC1_SAP_DESTINATION` alone selects
CC mode (the destination supplies host/creds/Cloud-Connector location).

## Deploy to BTP Cloud Foundry

The image deploys to CF as a docker app (see `manifest.yml`). Secrets stay out of
git — the API key and the registry pull token are passed at deploy time:

```bash
docker push ghcr.io/marianfoo/arc-1-lsp:0.0.1
# SAP connection + API key are secrets → set via cf set-env (never committed):
cf set-env arc-1-lsp ARC1_API_KEYS "$(openssl rand -hex 16)"
cf set-env arc-1-lsp ARC1_SAP_HOST a4h.marianzeis.de
cf set-env arc-1-lsp ARC1_SAP_PORT 50001
cf set-env arc-1-lsp ARC1_SAP_USER DEVELOPER
cf set-env arc-1-lsp ARC1_SAP_PASSWORD <secret>
cf set-env arc-1-lsp ARC1_SAP_DESTINATION A4H
# re-push (stop first if the org memory quota is tight — avoids transient 2×2G):
cf stop arc-1-lsp
CF_DOCKER_PASSWORD=$(gh auth token) cf push arc-1-lsp -f manifest.yml
```

Live (us10 free-tier): `https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com`
— `/healthz` (200), `/mcp` (API-key gated). `cf logs` shows
`engine: connected destination A4H`; the MCP `health` tool reports
`connectedDestination`, and `list_creatable_objects` returns the live a4h catalog.

For **on-prem via Cloud Connector** (CC mode): bind `connectivity` + `destination`
services, set only `ARC1_SAP_DESTINATION <btp-destination-name>` (drop the direct
`ARC1_SAP_HOST/PORT/USER/PASSWORD`), restage — the engine resolves the destination
and routes through the bridge automatically.

## Test a running instance (local or CF)

The `/mcp` endpoint is **stateless** StreamableHTTP — a bare `tools/call` works, no
session handshake. Quickest smoke test:

```bash
ARC1_URL=https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com/mcp \
ARC1_KEY=<api-key> bash scripts/smoke-remote.sh
# → /healthz ok · health {connectedDestination} · tools/list · list_creatable_objects
```

Or point any MCP client at the remote endpoint with the key as a bearer header:

```jsonc
// Claude Code:  claude mcp add --transport http arc1lsp \
//   https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com/mcp \
//   --header "Authorization: Bearer <api-key>"
//
// Cursor / Claude Desktop / VS Code (mcp.json):
{
  "mcpServers": {
    "arc1lsp": {
      "url": "https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

Or the GUI inspector: `npx @modelcontextprotocol/inspector` → Streamable HTTP →
the `/mcp` URL → add header `Authorization: Bearer <api-key>`.

## Status & roadmap

**Connected on BTP CF (Step 4) — green.** spawn adt-ls headless → start its MCP
over LSP → federate its 14 tools → build TLS material from adt-ls's JRE → start the
reverse proxy → **headless reentrance logon** → expose an arc-1-shaped MCP server
that returns real backend data. Verified live locally (macOS) and on BTP CF against
a4h (DIRECT mode).

Roadmap (see `docs/plans/`): ✅ foundation → ✅ containerize → ✅ deploy to BTP CF
→ ✅ headless connect (DIRECT) → **next:** CC-mode deploy (code ready, needs a
running Cloud Connector + destination), `read_source` via LSP `readFile`, more
curated tools, then per-user principal propagation. Background research lives in
the ARC-1 repo at `docs/research/arc1-embedded-adt-ls-edition.md`.

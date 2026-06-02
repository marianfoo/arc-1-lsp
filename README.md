# arc-1-lsp

An edition of **ARC-1** — a Model Context Protocol (MCP) server for SAP ABAP
development — that delegates **all** ABAP/ADT interaction to SAP's own embedded
**`adt-ls`** language server instead of a hand-rolled ADT HTTP client. arc-1-lsp
owns the MCP front-end, auth/scopes, write-safety, and orchestration; `adt-ls`
owns CSRF, locking, XML, activation, transport — everything system-specific.

> **Status:** working — connects headless to a SAP system, exposes 27 MCP tools
> (reads + LSP code-intelligence + a full create→edit→activate→test→delete authoring
> loop + RAP generation and transport), runs locally
> over stdio or as a Docker app on SAP BTP Cloud Foundry. Single-tenant / one
> technical user today; per-user principal propagation is on the roadmap.

## Where `adt-ls` comes from

`adt-ls` is **SAP's** language server: the headless core of the Eclipse-based
**ABAP Development Tools (ADT)**, shipped inside the official
[**ABAP Development Tools for VS Code**](https://marketplace.visualstudio.com/items?itemName=SAPSE.adt-vscode)
extension (`sapse.adt-vscode`). It exposes **three** surfaces, and arc-1-lsp drives
all of them:
1. **standard LSP code-intelligence** (`textDocument/*` — document symbols, go-to-
   definition, references/where-used, type hierarchy, diagnostics/syntax check,
   completion) — it *is* a language server;
2. a **private LSP namespace** (`adtLs/*` — destinations, logon, filesystem,
   activation, transport, unit tests);
3. an embedded **experimental MCP server** (object creation, activation, RAP
   generators, transports, …).

arc-1-lsp does not reimplement any of that — it **discovers, spawns, and drives**
the developer-provided `adt-ls` headless (no Eclipse, no VS Code, no browser). The
`adt-ls` binary is under SAP's Developer License and is **never bundled or
redistributed** — you bring your own (see [Prerequisites](#prerequisites) and
[ADR-0002](docs/adr/0002-byo-adt-ls-no-redistribution.md)).

## arc-1-lsp vs. main ARC-1 — which should I use?

Both are MCP servers for SAP ABAP and share the same tool shape. They differ in
*how* they talk to SAP, and therefore in what they can do.

| | **[ARC-1](https://github.com/marianfoo/arc-1)** (main) | **arc-1-lsp** (this repo) |
|---|---|---|
| ADT protocol | Hand-rolled (CSRF, locking, XML, version quirks) | Delegated to SAP's `adt-ls` |
| System-specific code to maintain | ~29 ADT modules | ~zero (it's SAP's job) |
| Object-type coverage | **All** — classic *and* modern (programs, tables, function groups, domains, CDS, classes, RAP, …) | **Modern ABAP-Cloud types only** (class, interface, CDS, behavior def, service def/binding, …) |
| Free SQL / data preview | ✅ | ❌ (absent in adt-ls) |
| Navigation / where-used / type hierarchy | ✅ | ✅ (via adt-ls's standard LSP — `textDocument/*`) |
| Syntax check / ATC | ✅ | ◐ syntax check ✅ (`check_syntax`); ATC deep checks ❌ |
| Git (gCTS / abapGit) | ✅ | ❌ (absent in adt-ls) |
| Maturity | Production, multi-user, write-capable | Working; reads + authoring loop; single technical user |

**Use main ARC-1** for the broadest coverage (classic objects, free SQL, ATC deep
checks, git) and production multi-user deployments. **Use arc-1-lsp** when you want
SAP itself to own the ADT protocol — less code to maintain, and behavior that
tracks ADT exactly (including its standard LSP code-intelligence) — and your work
is on modern ABAP-Cloud objects.

The honest, line-by-line map of what is and isn't wired (and *why*) lives in
[`docs/arc-1-feature-parity.md`](docs/arc-1-feature-parity.md); the live-verified
capability boundary of `adt-ls` itself is in
[`docs/adt-ls-reference.md`](docs/adt-ls-reference.md).

## What works today

**27 MCP tools.** Reads work read-only; mutating tools are gated behind
`ARC1_ALLOW_WRITES` + a package allowlist (transport creation additionally needs
`ARC1_ALLOW_TRANSPORT_WRITES`).

- **Reads (14):** `health`, `list_destinations`, `list_creatable_objects`,
  `search_objects`, `list_inactive_objects`, `list_users`, `list_generators`,
  `get_generator_schema`, `get_object_type_details`, `get_service_binding`,
  `get_service_details`, `read_source`, `validate_object`, `find_transport`.
- **Code intelligence (6, LSP):** `document_symbols` (outline), `go_to_definition`,
  `find_references`, `type_hierarchy` (super/subtypes + implementations),
  `check_syntax` (the ABAP syntax check, no activation needed), `completion`.
  adt-ls is a language server — these proxy its standard `textDocument/*` APIs;
  target a declared `symbol` by name or a 1-based `line`+`character`.
- **Authoring loop (5, write-gated):** `create_object`, `update_source`,
  `activate_object`, `run_unit_tests`, `delete_object` — a full
  create → edit → activate → test → delete cycle, by object name, for modern
  ABAP-Cloud types. `activate_object` returns ranged syntax diagnostics so an
  agent can self-correct.
- **Generation + transport (2, gated):** `generate_objects` runs a RAP generator
  (scaffolds a full table/CDS/behavior/service set); `create_transport` opens a
  CTS transport request. For transportable (non-`$TMP`) packages the flow is
  `validate_object` → `find_transport` → (`create_transport`) →
  `create_object`/`generate_objects` (pass the TR as `transport`).

**Out of scope here (use main ARC-1):** classic object types (program/table/
function group/domain/…), free SQL, ATC deep checks (`atc/runCheck`), transport
*release/delete*, and git. These are honest limits of `adt-ls`'s headless surface,
not missing features — details in [`docs/arc-1-feature-parity.md`](docs/arc-1-feature-parity.md).

The SAP session behind `adt-ls` self-heals: if it expires (idle timeout →
"logged off"), arc-1-lsp transparently re-logs on and retries the call once.

## Architecture

```
agent (Claude / Copilot / Cursor / …)
   │  MCP (stdio | http-streamable)
   ▼
arc-1-lsp  (Node/TS — discovers, spawns & supervises adt-ls; auth + scopes; owns SAP logon)
   ├─ LSP over pipe ───────────▶ adt-ls (headless, BYO)   ← bootstrap, destinations, logon, filesystem, activation
   └─ HTTP localhost ─────────▶ adt-ls's own /mcp         ← federated tools
                                      │ HTTPS
                                      ▼
                          TLS reverse proxy (CN=localhost, in arc-1-lsp)
                                      │  DIRECT ───────────────▶ SAP ABAP (internet-reachable)
                                      └  CC ─▶ connectivity bridge ─▶ BTP Connectivity ─▶ Cloud Connector ─▶ SAP ABAP
```

`adt-ls` requires an **HTTPS** backend and validates its hostname; SAP's default
self-signed cert (`CN=*.dummy.nodomain`) fails that. So arc-1-lsp runs a local
**TLS-terminating reverse proxy** (cert `CN=localhost`, trusted via a truststore
built from `adt-ls`'s own JRE) and re-originates to the real backend — directly,
or through the connectivity bridge on BTP. Logon is **headless reentrance-ticket**
emulation (no browser). Full recipe + decisions:
[`docs/adt-ls-headless-notes.md`](docs/adt-ls-headless-notes.md) +
[`docs/adr/`](docs/adr/README.md).

## Prerequisites

1. **Node.js 22+**.
2. **A developer-provided `adt-ls`** (BYO — never redistributed). Install the
   official **ABAP Development Tools for VS Code** extension (`sapse.adt-vscode`,
   which accepts SAP's Developer License) and arc-1-lsp finds its `adt-ls`
   automatically. Discovery order:
   1. `ARC1_ADT_LS_PATH` (explicit path)
   2. `vendor/adt-ls/<platform>/…` (build-time injection, for containers)
   3. the newest installed `sapse.adt-vscode-*` VS Code extension
3. **A reachable SAP ABAP system** to connect to (optional — the server also
   starts disconnected and still serves `health`/`tools`). Runtime cert/proxy
   deps: `openssl` + `keytool` (the latter ships inside `adt-ls`'s JRE). See
   [`docs/native-deps.md`](docs/native-deps.md).

> **Compatibility:** arc-1-lsp drives `adt-ls`'s private `adtLs/*` protocol, which
> can change between releases. This build is verified against `sapse.adt-vscode`
> **1.0.0** / adt-ls **1.0.0.202605281240**; on a different version arc-1-lsp logs
> a startup warning and you should re-verify against
> [`docs/adt-ls-reference.md`](docs/adt-ls-reference.md).

## Install & run

### From source (stdio)

```bash
npm install
npm run build
node dist/index.js          # or: npm run dev (tsx, no build)
```

Point an MCP client at the process over **stdio**. With no SAP vars set it starts
disconnected (handy for inspecting the tool list); set `ARC1_SAP_*` to auto-connect
(see [Connect a SAP system](#connect-a-sap-system)).

### As a CLI (npm)

```bash
npm install -g arc1-lsp
arc1-lsp                    # stdio MCP server (honors the same env/flags)
```

The npm package ships the Node wrapper only — it still discovers your BYO `adt-ls`
(it does **not** contain any SAP binary).

### Docker / http-streamable

The container bundles a **build-time-injected** linux `adt-ls` and serves MCP over
http-streamable behind an API key — this is the artifact deployed to BTP CF.

```bash
# stage the linux adt-ls (admin provides the licensed VSIX → vendor/)
node scripts/extract-adt-ls.mjs
# build the linux/amd64 image (host-builds dist; only prod deps + adt-ls are amd64)
IMAGE=arc-1-lsp:dev bash scripts/docker-build.sh
# run
docker run -e ARC1_API_KEYS=devkey -p 8080:8080 arc-1-lsp:dev
```

`GET /healthz` (no auth) for health checks; `POST /mcp` with
`Authorization: Bearer <key>` for MCP.

## Connect a SAP system

Set the `ARC1_SAP_*` vars (or `--sap-*` flags) and arc-1-lsp logs on at startup.

```bash
ARC1_SAP_HOST=a4h.example.com ARC1_SAP_PORT=50001 \
ARC1_SAP_USER=DEVELOPER ARC1_SAP_PASSWORD=… ARC1_SAP_DESTINATION=A4H \
node dist/index.js
```

`health` then reports `connectedDestination`, and `list_creatable_objects` returns
the system's object catalog. Two connection modes:

- **DIRECT** (default) — the reverse proxy connects straight to an
  internet-reachable backend. All four of `HOST`/`PORT`/`USER`/`PASSWORD` must be set.
- **CC** (on-prem via Cloud Connector, on BTP) — bind the `connectivity` +
  `destination` services and set only `ARC1_SAP_DESTINATION <btp-destination-name>`;
  the engine resolves it and routes through the connectivity bridge automatically.

### Connect an MCP client

```jsonc
// Claude Code (HTTP):
//   claude mcp add --transport http arc1lsp https://<host>/mcp \
//     --header "Authorization: Bearer <api-key>"
//
// Cursor / Claude Desktop / VS Code — mcp.json:
{
  "mcpServers": {
    "arc1lsp": {
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

For local stdio, point the client at the `node dist/index.js` (or `arc1-lsp`)
process instead of a URL. GUI inspector: `npx @modelcontextprotocol/inspector`.

## Configuration (precedence: CLI flag > env var > default)

| Env / flag | Default | Meaning |
|------------|---------|---------|
| `ARC1_ADT_LS_PATH` / `--adt-ls-path` | (discovered) | explicit `adt-ls` binary |
| `ARC1_ADT_LS_MCP_PORT` / `--adt-ls-mcp-port` | `2240` | port for `adt-ls`'s own MCP server |
| `ARC1_ADT_LS_MCP_TOKEN` / `--adt-ls-mcp-token` | (generated) | bearer for `adt-ls`'s MCP server |
| `ARC1_TRANSPORT` / `--transport` | `stdio` | `stdio` \| `http-streamable` |
| `ARC1_PORT` / `--port` | `8080` | HTTP port (http-streamable; CF `$PORT` honored) |
| `ARC1_API_KEYS` / `--api-keys` | (none) | edge auth: `key[:label-or-profile][,key2…]`; empty disables auth (local only). A profile suffix `:viewer`/`:developer`/`:admin` assigns scopes (per-tool enforcement arrives with the XSUAA edge — see [ADR-0007](docs/adr/0007-enterprise-auth-scopes-xsuaa-pp.md)); any other suffix is a free label (defaults to `developer`) |
| `ARC1_ALLOW_WRITES` / `--allow-writes` | `false` | enable mutating tools (create/update/activate/delete/generate) |
| `ARC1_ALLOW_TRANSPORT_WRITES` / `--allow-transport-writes` | `false` | enable CTS transport creation (`create_transport`) — also requires `ARC1_ALLOW_WRITES` |
| `ARC1_ALLOWED_PACKAGES` / `--allowed-packages` | `$TMP` | packages writes may target — exact / `PREFIX*` / `*` |
| `ARC1_LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error` (stderr only) |
| **SAP connection — DIRECT mode** (internet-reachable backend) | | |
| `ARC1_SAP_HOST` / `--sap-host` | — | backend host |
| `ARC1_SAP_PORT` / `--sap-port` | — | backend **HTTPS** port |
| `ARC1_SAP_USER` / `--sap-user` | — | SAP user (the reentrance ticket is fetched with these creds) |
| `ARC1_SAP_PASSWORD` / `--sap-password` | — | SAP password (set via env / `cf set-env`, never committed) |
| `ARC1_SAP_DESTINATION` / `--sap-destination` | `SAP` | `adt-ls` destination id (DIRECT) **or** BTP destination name (CC) |
| `ARC1_SAP_CLIENT` / `--sap-client` | `001` | SAP client |
| `ARC1_SAP_LANGUAGE` / `--sap-language` | `EN` | SAP logon language |
| `ARC1_SAP_INSECURE` / `--sap-insecure` | `true` | accept the backend's self-signed cert (the proxy's own TLS is trusted separately) |
| **SAP connection — CC mode** (on-prem via Cloud Connector) | | |
| `ARC1_SAP_DESTINATION` | — | BTP Destination Service name; resolved when `connectivity` is bound |

> Config is read from CLI flags and the process environment only (no `.env`
> auto-loading) — export the vars in your shell or set them via `cf set-env`.

## Deploy to BTP Cloud Foundry

The image deploys to CF as a docker app (see `manifest.yml`). Secrets stay out of
git — the API key, SAP creds, and the registry pull token are passed at deploy time:

```bash
docker push ghcr.io/<owner>/arc-1-lsp:0.1.0
# secrets via cf set-env (never committed):
cf set-env arc-1-lsp ARC1_API_KEYS "$(openssl rand -hex 16)"
cf set-env arc-1-lsp ARC1_SAP_HOST   <host>
cf set-env arc-1-lsp ARC1_SAP_PORT   50001
cf set-env arc-1-lsp ARC1_SAP_USER   <user>
cf set-env arc-1-lsp ARC1_SAP_PASSWORD <secret>
cf set-env arc-1-lsp ARC1_SAP_DESTINATION <id>
cf set-env arc-1-lsp ARC1_ALLOW_WRITES true          # optional, to enable the authoring loop
cf set-env arc-1-lsp ARC1_ALLOWED_PACKAGES '$TMP'    # scope writes
# re-push (stop first if the org memory quota is tight — avoids a transient 2×2G):
cf stop arc-1-lsp
CF_DOCKER_PASSWORD=$(gh auth token) cf push arc-1-lsp -f manifest.yml
```

`cf logs` shows `engine: connected destination …`; the MCP `health` tool reports
`connectedDestination`. `cf push` preserves `cf set-env` vars not listed in the
manifest. If the ghcr image is private, CF pulls it with `CF_DOCKER_PASSWORD`;
make the package public to drop that.

## Test a running instance (local or CF)

The `/mcp` endpoint is **stateless** StreamableHTTP — a bare `tools/call` works, no
session handshake.

```bash
ARC1_URL=https://<host>/mcp ARC1_KEY=<api-key> bash scripts/smoke-remote.sh
# → /healthz ok · health {connectedDestination} · tools/list · list_creatable_objects
```

## Documentation

| Doc | What it covers |
|-----|----------------|
| [`docs/adt-ls-reference.md`](docs/adt-ls-reference.md) | **The authoritative, live-verified `adt-ls` capability map** — URI model, the `getLsUri` name→URI resolver, the method/tool matrix, the object-type boundary, the proven lifecycle, session self-heal, gotchas |
| [`docs/arc-1-feature-parity.md`](docs/arc-1-feature-parity.md) | arc-1 vs arc-1-lsp coverage, per-capability "implemented? why / why not" |
| [`docs/research/adt-ls-capability-map.md`](docs/research/adt-ls-capability-map.md) | **The complete DECOMPILED `adt-ls` surface** (ground truth — CFR-decompiled `com.sap.adt.ls`): all 23 `adtLs/*` segments / ~92 methods with DTO shapes + per-capability usefulness triage + wiring gap. Corrects hover/ATC/formatting verdicts; documents the embedded MCP server's dynamic tool collection |
| [`docs/research/whats-left-on-sap.md`](docs/research/whats-left-on-sap.md) | The earlier extension-front-end inventory (superseded in part by the capability map above) — strategic "what's reachable-but-unwired vs blocked-on-SAP" framing |
| [`docs/adt-ls-headless-notes.md`](docs/adt-ls-headless-notes.md) | The reverse-engineered headless connection recipe (initialize, reentrance-ticket logon, TLS/truststore) |
| [`docs/adr/`](docs/adr/README.md) | Architecture Decision Records — each decision, its context, and **when to revisit** it |
| [`docs/assumptions-and-future-changes.md`](docs/assumptions-and-future-changes.md) | The watch-list: what to re-verify against new `adt-ls` releases, and what would let us delete complexity |
| [`docs/native-deps.md`](docs/native-deps.md) | System libraries `adt-ls` needs in a slim container |
| [`docs/journey.md`](docs/journey.md) | The chronological story, including dead-ends (so they aren't re-walked) |

Contributing? See [`CONTRIBUTING.md`](CONTRIBUTING.md) (setup, tests, conventions)
and [`SECURITY.md`](SECURITY.md) (reporting vulnerabilities). Working with Claude
Code? [`CLAUDE.md`](CLAUDE.md) is the design + codebase map. Releases are
automated from Conventional Commits via release-please.

## Status & roadmap

✅ foundation → ✅ containerize → ✅ deploy to BTP CF → ✅ headless connect
(DIRECT) → ✅ read + authoring-loop + generation/transport tools →
✅ session self-heal → ✅ LSP code-intelligence (27 tools).

**Next:** CC-mode deploy (code ready; needs a running Cloud Connector + bound
`connectivity`/`destination`), then **per-user principal propagation** (one
`adt-ls` session per user via the BTP Destination Service). Roadmap detail in
[`docs/plans/`](docs/plans/) and [`docs/assumptions-and-future-changes.md`](docs/assumptions-and-future-changes.md).

## License & credits

[MIT](LICENSE) © 2026 Marian Zeis and contributors.

Built on the shell of **[ARC-1](https://github.com/marianfoo/arc-1)** (MIT,
© Alice Vinogradova and contributors) — arc-1-lsp reuses its MCP server,
configuration, authorization model, audit, and logging patterns. SAP's `adt-ls`
is **not** included or redistributed (SAP Developer License) — bring your own; see
[ADR-0002](docs/adr/0002-byo-adt-ls-no-redistribution.md).

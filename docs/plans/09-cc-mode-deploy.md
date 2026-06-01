# Plan 09 — CC-mode CF deploy (Cloud Connector path)

## Goal

Deploy + verify arc-1-lsp's already-coded Cloud-Connector path (reach an on-prem
SAP system through the BTP Connectivity service → Cloud Connector, instead of
DIRECT internet connect). The CC code shipped in 0.0.1 (engine `planConnection`
connectivity branch + `src/btp/bridge.ts` + reverse-proxy `forwardProxy`); this
plan is about **deploying** it, not writing it.

## Live CF state (recon 2026-06-01)

| | Finding |
|---|---|
| arc-1-lsp app | `started` in org `Marian Zeis_dev-9li7mzug` / space `abap-dev`, route `arc-1-lsp.cfapps.us10-001.hana.ondemand.com` (DIRECT mode, image `ghcr.io/marianfoo/arc-1-lsp:0.0.1`) |
| Services in `abap-dev` | `arc1-301-dest` (destination), `arc1-301-xsuaa` (xsuaa), `abap-free` (a BTP ABAP env). **NO `connectivity` service.** |
| Connectivity + CC | Exist only in the OTHER org `Marian_Zeis_joule2-7lrbs13d` / space `dev` (`arc1-connectivity` + `arc1-destination`, bound to the main arc-1 apps `arc1-mcp-*`). |
| Docker daemon | **Down** on this machine — `cf push` uses a pre-built Docker image, so a new build (W1/W2 tools) can't be produced right now. |

## HARD BLOCKERS (why this can't fully execute headlessly today)

1. **Docker daemon not running** → can't build/push a new `linux/amd64` image, so
   neither a CC-mode nor a refreshed-DIRECT deploy of the W1/W2 build can ship.
   *Remediation:* start Docker Desktop; then `scripts/docker-build.sh` + push + `cf push`.
2. **No `connectivity` service (and no confirmed CC→a4h destination) in the
   `abap-dev` space.** a4h is internet-reachable, so it was never put behind a CC;
   the CC infra lives in the `joule2` org for the main arc-1. CC-mode needs a
   `connectivity` instance + a Cloud Connector + a BTP destination whose URL is the
   CC **virtual host** for a4h (HTTP virtual host — the connectivity proxy 405s on
   CONNECT, so HTTPS virtual hosts won't tunnel; assumptions §3).
   *Remediation:* provision/choose the org, create + bind `connectivity` +
   `destination`, define the destination (below), then deploy.

Both are infrastructure/host actions the user must take; the code + deploy
artifacts below make it turnkey afterwards.

## Tasks (what IS deliverable now — no blockers)

### Task 1 — CC-mode manifest + service bindings
- Add a documented `services:` block (connectivity + destination) — as
  `manifest-cc.yml` (or a commented section) — so `cf push -f manifest-cc.yml`
  binds both. Keep secrets out (set-env only). The image stays the same; mode is
  selected purely by env (`ARC1_SAP_DESTINATION` set + connectivity bound →
  `planConnection` picks `connectivity`; DIRECT `ARC1_SAP_*` must be unset).

### Task 2 — CC-mode deploy runbook (`docs/cc-mode-deploy.md`)
- End-to-end: (a) Cloud Connector — expose a4h as an HTTP virtual host; (b) BTP —
  create a `destination` service instance + a destination (`SAP_TRIAL`: URL =
  `http://<virtual-host>:<port>`, ProxyType `OnPremise`, basic auth `DEVELOPER`,
  `CloudConnectorLocationId` if used); (c) create + bind `connectivity` +
  `destination`; (d) `cf set-env ARC1_SAP_DESTINATION SAP_TRIAL`, unset the direct
  `ARC1_SAP_HOST/PORT/USER/PASSWORD`; (e) `cf push`/`cf restage`; (f) verify via
  `cf logs` (expect: bridge `127.0.0.1:<port> → onpremise_proxy_host`,
  `tls-reverse-proxy … via connectivity bridge`, `connected destination SAP_TRIAL`).
- Document the HTTP-virtual-host requirement + the org/connectivity prerequisite.

### Task 3 — Verify the CC code path
- Re-read `engine.connect()` connectivity branch + `src/btp/{bridge,connectivity,
  destination,vcap}.ts`; confirm `planConnection` selects connectivity when
  `btp.connectivityProxyHost` + `sapDestination` are set. Ensure unit coverage
  exists (`planConnection` modes; bridge forwarding). Add a `planConnection` test
  if missing.

### Task 4 — Record state + blockers
- Update `docs/assumptions-and-future-changes.md` §9 (BTP env: the two orgs, which
  has connectivity, the abap-dev space contents) + journey, so the next session
  knows the exact CF topology.

## Validation
- `npm run build` · `typecheck` · `lint` · `test` (CC code path test green).
- Deploy verification is **infra-gated** (blockers above) — documented as the
  runbook's verify step, executed once Docker + a CC + connectivity are available.

## Out of scope
- Provisioning a Cloud Connector / connectivity service (user infra).
- OAuth reentrance for BTP ABAP (`abap-free`/H01) — basic-auth reentrance only
  today (assumptions §8); that's a separate plan.
- Per-user PP (W4).

# Deploying arc-1-lsp in Cloud-Connector (CC) mode

arc-1-lsp's **DIRECT** mode connects straight to an internet-reachable SAP system
(e.g. a4h). **CC mode** reaches an **on-premise** system through the BTP
**Connectivity** service → **Cloud Connector**. The code for this is built and
unit-tested (`planConnection` connectivity branch + `src/btp/bridge.ts`); this is
the operational runbook to deploy + verify it.

> **Why a bridge?** `adt-ls` (Java/Apache HttpClient) doesn't speak BTP
> Connectivity. arc-1-lsp runs a tiny local forward proxy
> ([`src/btp/bridge.ts`](../src/btp/bridge.ts)) that adds the connectivity token +
> `SAP-Connectivity-SCC-Location_ID` and forwards to the BTP connectivity proxy
> using **standard HTTP-proxy protocol (NOT CONNECT)** — the proxy `405`s on
> CONNECT. The TLS reverse proxy's upstream is pointed at the bridge. See
> [ADR-0005](adr/0005-auth-injecting-proxy.md) and
> [assumptions §3](assumptions-and-future-changes.md).

## Prerequisites

1. **A Cloud Connector** connecting your BTP subaccount to the on-prem system,
   exposing it as an **HTTP virtual host** (e.g. `a4h-virtual:50001`).
   ⚠ The virtual host MUST be **HTTP**, not HTTPS — the connectivity proxy `405`s
   on CONNECT, so an HTTPS virtual host won't tunnel. (TLS to adt-ls is handled
   locally by arc-1-lsp's reverse proxy regardless.)
2. A space with the **`connectivity`** and **`destination`** service offerings
   available (e.g. plan `lite`). *Note: as of 2026-06, arc-1-lsp lives in
   `Marian Zeis_dev-9li7mzug` / `abap-dev`, which has `destination` but NOT
   `connectivity`; the connectivity service currently exists only in the
   `Marian_Zeis_joule2-7lrbs13d` org for the main arc-1. Provision `connectivity`
   in the target space first.*

## Step 1 — Define the BTP destination

In the BTP cockpit (or via the destination service), create a destination — name
it e.g. `SAP_TRIAL`:

| Property | Value |
|----------|-------|
| Name | `SAP_TRIAL` |
| Type | `HTTP` |
| URL | `http://<cc-virtual-host>:<port>` (the CC virtual host, **http**) |
| ProxyType | `OnPremise` |
| Authentication | `BasicAuthentication` (user `DEVELOPER` + password) |
| `CloudConnectorLocationId` | (only if your CC uses a location id) |

arc-1-lsp reads `URL`, `User`, `Password`, `sap-client`, and
`CloudConnectorLocationId` from this destination
([`src/btp/destination.ts`](../src/btp/destination.ts)).

## Step 2 — Create + bind the services

```bash
cf target -o "<org>" -s "<space>"
cf create-service connectivity lite arc1-connectivity   # if not already present
cf create-service destination  lite arc1-destination     # if not already present
cf bind-service arc-1-lsp arc1-connectivity
cf bind-service arc-1-lsp arc1-destination
```

Or push with [`manifest-cc.yml`](../manifest-cc.yml), which declares both under
`services:`.

## Step 3 — Switch arc-1-lsp to CC mode (env)

CC mode is selected purely by config: a destination name set **and** a
connectivity binding present makes `planConnection` choose `connectivity`; the
DIRECT `ARC1_SAP_*` vars must be **unset** so they don't win.

```bash
cf set-env arc-1-lsp ARC1_SAP_DESTINATION SAP_TRIAL
cf unset-env arc-1-lsp ARC1_SAP_HOST
cf unset-env arc-1-lsp ARC1_SAP_PORT
cf unset-env arc-1-lsp ARC1_SAP_USER
cf unset-env arc-1-lsp ARC1_SAP_PASSWORD
```

(Credentials now come from the destination, not env.)

## Step 4 — Deploy + restage

```bash
cf push -f manifest-cc.yml         # binds services + pulls the image
# or, if already bound and only env changed:
cf restage arc-1-lsp
```

> Tip: org memory quota is tight — `cf stop arc-1-lsp` before a re-push to avoid a
> transient 2×2G (old + new).

## Step 5 — Verify (`cf logs arc-1-lsp --recent`)

Expect the full CC chain in the logs:

```
connectivity bridge on 127.0.0.1:<p> → <onpremise_proxy_host>:<port>
tls-reverse-proxy: https://localhost:<q> → http://<cc-virtual-host>:<port> via connectivity bridge 127.0.0.1:<p>
engine: connected destination SAP_TRIAL
arc-1-lsp MCP server ready (http-streamable) on :<PORT>/mcp
```

Then hit the MCP endpoint (API-key auth) and confirm `health` reports
`connectedDestination: SAP_TRIAL` and `list_creatable_objects` returns the real
catalog — same checks as DIRECT mode ([`scripts/smoke-remote.sh`](../scripts/smoke-remote.sh)).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `connectivity service binding missing onpremise_proxy_host` | `connectivity` not bound, or VCAP missing — re-bind + restage. |
| Bridge connects but backend `405`/timeout | CC virtual host is **HTTPS** — must be HTTP (CONNECT not supported). |
| `logon … failed` | Destination URL/creds wrong, or the CC mapping is down. Check the CC's "Cloud To On-Premise" system + the destination's `CheckConnection`. |
| Reaches a BTP ABAP system (valid cert, OAuth) | CC mode is for on-prem basic-auth; BTP ABAP needs OAuth reentrance — not yet supported (assumptions §8). |

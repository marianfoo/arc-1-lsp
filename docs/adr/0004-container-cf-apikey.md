# ADR-0004: Docker image on Cloud Foundry; API-key edge auth for v1

## Status
Accepted (2026-05-29)

## Context
arc-1-lsp must run on BTP CF (the goal: a deployed MCP server). adt-ls is a JVM/
Eclipse app — you can't `npx` it on CF. CF needs a port-listening HTTP app. The
edge (client→arc-1-lsp) needs auth, and ARC-1 supports API key / XSUAA / OIDC.

## Decision
- **Package as a Docker image** and deploy via `cf push --docker-image` (verified
  `diego_docker` is **enabled** on the target US10 landscape). Host-build `dist/`
  + prod `node_modules` (pure JS) and inject the linux adt-ls; only the apt native
  deps run under emulation (`docs/native-deps.md`).
- **Transport: http-streamable** (`/mcp`) + `GET /healthz` (CF health check).
- **Edge auth: API key** (`ARC1_API_KEYS`) for v1 — minimal, no XSUAA service
  setup. Secrets via `cf set-env`, never in the manifest/image.
- **Honor CF `$PORT`** (don't bake a port).

## Consequences
- Live on CF: `https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com` (health + MCP
  proven end-to-end with the embedded adt-ls booting in-container).
- Image is ~508 MB (the JVM + adt-ls dominate) → CF app sized 2 GB; cold start
  includes JVM/Eclipse boot (`timeout: 180`).
- API-key auth is per-deployment, not per-user. XSUAA/OIDC + per-user identity is
  a later step (and ties into ADR-0005).
- Image is built/pushed privately (ADR-0002); CF pulls it (public package, or a
  pull token).

## Revisit when
- Multi-user / enterprise → swap API key for **XSUAA/OIDC** (reuse ARC-1's auth).
- A non-CF target (Kyma, plain k8s, on-prem Docker) → manifest/health specifics
  change but the image is portable.

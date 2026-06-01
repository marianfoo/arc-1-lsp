# Plan 08 — Publishing & docs polish

## Goal

Make arc-1-lsp properly adoptable + maintainable as a published OSS package:
contributor/security/onboarding docs, a starter env file, CI, automated
versioning, and an adt-ls version-compat guard. No risky auto-publish (npm/ghcr
stay manual until the user opts in — they publish by hand today).

## Context (recon)

- **No `.github/` at all** — no CI, no release automation.
- `'0.0.1'` is hardcoded in 4 spots: `driver.ts` (clientInfo + userAgentInfos),
  `server.ts` (McpServer version), `mcp-federation.ts` (clientInfo). → centralize.
- No `SECURITY.md` / `CONTRIBUTING.md` / `.env.example`.
- `.gitignore` ignores `.env` (so `.env.example` is safe to commit).
- Installed adt-ls is `1.0.0.202605281240`; the private LSP protocol can break
  between releases (assumptions §6) — warn on mismatch.
- **ghcr image is still `private`** → `manifest.yml` `username:` cleanup stays
  BLOCKED on the user's UI toggle. Out of scope here; leave a note.

## Tasks

### Task 1 — Centralize the version (`src/version.ts`)
- New `src/version.ts`: `export const VERSION = '0.0.1'; // x-release-please-version`.
- Replace the 4 hardcoded `'0.0.1'` with `VERSION` (driver.ts ×2, server.ts,
  mcp-federation.ts). Single source release-please can bump.
- Tests: update any assertion on `'0.0.1'` (grep tests first); add a tiny test
  that `VERSION` is a semver string and that `createMcpServer` advertises it.

### Task 2 — adt-ls version-compat guard
- `src/version.ts` (or engine): `export const EXPECTED_ADT_LS_VERSION = '1.0.0.202605281240'`.
- `engine.ts` (after `driver.start()` / the "adt-ls ready" log): if the detected
  `serverInfo.version` !== expected, `logger.warn(...)` naming both versions +
  "the private adtLs/* protocol may have changed; re-verify (assumptions §6)".
  Non-fatal.
- Tests: a unit test for the pure compare helper (`isExpectedAdtLsVersion` or an
  inline `warnOnAdtLsVersionMismatch(detected, log)` pure fn) — match → no warn,
  mismatch → one warn.

### Task 3 — `.env.example`
- Copy-paste starter: transport, http port, api keys, the `ARC1_SAP_*` direct
  block (commented), `ARC1_SAP_DESTINATION` (CC), write-safety flags, adt-ls path.
  Comments mirror the README config table. Secrets shown as placeholders.

### Task 4 — `SECURITY.md`
- Supported versions; reporting channel (GitHub private security advisory; no
  public issues for vulns); what's in scope (arc-1-lsp code) vs not (SAP's adt-ls
  — BYO, report to SAP; the SAP backend); secrets handling (env only, never
  commit; redaction); safe-harbor. Adapt arc-1's SECURITY.md tone, scaled to v1.

### Task 5 — `CONTRIBUTING.md`
- BYO adt-ls setup (`extract-adt-ls.mjs` or `ARC1_ADT_LS_PATH`; ADR-0002 — never
  commit the binary); build/test/lint/typecheck; the skipIf-gated test convention
  (`ARC1_TEST_SAP_PASSWORD`, never in CI, $TMP + cleanup); ESM/.js-extension +
  Biome rules; conventional commits (release-please); where ADRs + plans live;
  the "record adt-ls findings in adt-ls-reference.md" rule.

### Task 6 — CI (`.github/workflows/ci.yml`)
- On push + PR: `npm ci` → build → typecheck → lint → test. Node 22.
- adt-ls-dependent + SAP smoke tests **self-skip** in CI (no binary / no
  `ARC1_TEST_SAP_PASSWORD`) — VERIFY each smoke test is gated on
  `resolveAdtLsPath()` so CI is green without adt-ls. Pin GitHub-owned actions by
  tag (`actions/checkout@v4`, `actions/setup-node@v4`).

### Task 7 — release-please (versioning + changelog + GitHub release ONLY)
- `release-please-config.json` (release-type `node`; `extra-files`: `src/version.ts`
  generic updater for the marker) + `.release-please-manifest.json` (`{".":"0.0.1"}`).
- `.github/workflows/release-please.yml`: the release-please action (SHA-pinned —
  third-party) on push to `main`; opens/maintains the Release PR and cuts the tag +
  GitHub Release on merge. **No npm/docker publish step** (documented as manual /
  future opt-in — needs npm trusted-publishing + OIDC the user must set up).

### Task 8 — README/manifest notes
- README: a short "Compatibility" line (tested adt-ls version) near Prerequisites;
  note release/versioning is release-please-driven.
- `manifest.yml`: leave `username:` (ghcr still private); add/keep the inline note
  that it drops once the package is public.

## Validation
- `npm run build` · `typecheck` · `lint` · `test` (all green; smoke tests skip).
- `git` hygiene: no `.env`, no adt-ls binary, no secrets staged.
- CI/release-please workflows are GitHub-only at runtime — assert they're
  syntactically valid + follow the canonical pattern; cannot execute locally.

## Out of scope
- Automated npm/ghcr publish (manual today; opt-in later).
- ghcr-public toggle + `manifest.yml username` removal (user UI action).
- Per-key scopes / audit (W4).

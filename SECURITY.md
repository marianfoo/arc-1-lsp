# Security Policy

## Supported versions

arc-1-lsp is pre-1.0 and ships from `main`. Security fixes land on the latest
published version (npm `arc-1-lsp`, `ghcr.io/marianfoo/arc-1-lsp`); please be on
the latest release before reporting.

| Version | Supported |
|---------|-----------|
| latest `0.x` | ✅ |
| older `0.x` | ❌ (upgrade) |

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately via GitHub **Security advisories** →
<https://github.com/marianfoo/arc-1-lsp/security/advisories/new>, or email the
maintainer (see the GitHub profile). Please include:

- affected version / commit and how arc-1-lsp was deployed (stdio, Docker, BTP CF);
- a description, impact, and reproduction steps or a proof-of-concept;
- any relevant logs **with secrets redacted**.

You can expect an acknowledgement within a few business days and an assessment of
severity + fix plan thereafter. Coordinated disclosure is appreciated — we'll
agree a disclosure timeline with you and credit you unless you prefer otherwise.

## Scope

**In scope** — the arc-1-lsp code in this repository: the MCP server shell, the
API-key edge auth, the write-safety layer (`allowWrites` / `allowTransportWrites`
/ package allowlist), the TLS reverse proxy + truststore handling, the BTP
connectivity bridge, and secret/credential handling in logs and config.

**Out of scope:**

- **SAP's `adt-ls`** — arc-1-lsp does not ship or modify it (BYO, ADR-0002).
  Vulnerabilities in adt-ls itself belong to SAP; report them through SAP channels.
- **The SAP backend** (ABAP system, BTP, Cloud Connector) — report to SAP / your
  system operator. arc-1-lsp relies on SAP's native authorization (S_DEVELOP,
  package checks) as the backstop.
- Findings that require an already-compromised host, a malicious admin, or
  credentials the reporter was legitimately given.

## Handling of secrets

- SAP credentials, API keys, and tokens are passed via environment / `cf set-env`
  — **never commit them**. `.env`, `cookies.txt`, service keys are gitignored.
- Per-user auth never inherits shared credentials; the reverse proxy and bridge
  hold secrets in memory only.
- If you find a secret committed to history, treat it as compromised: report it
  privately and rotate it immediately.

## Safe harbor

We will not pursue or support legal action against good-faith security research
that respects this policy, avoids privacy violations and service disruption, and
gives us reasonable time to remediate before public disclosure.

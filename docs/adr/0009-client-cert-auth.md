# ADR-0009: Passwordless X.509 client-certificate logon (`clientcert` auth mode)

## Status
Accepted (2026-06-12) — **PROVEN end-to-end against a4h**: passwordless `GET
/sap/bc/adt/discovery` → 200 as MARIAN (no-cert → 401), and arc-1-lsp's engine connects
+ runs a repository search with no password and no browser. Shipped as
`@marianfoo/adt-ls` `clientCert()` (0.5.0) + arc-1-lsp `ARC1_SAP_AUTH=clientcert`.

## Context
The browser-SSO path (`interactive` / `ARC1_SAP_AUTH=sso`) has two pains for local dev:
the IdP redirect can stall behind the localhost reverse proxy, and an a4h session dies in
~2 min idle → a browser pop on the next call. SNC/Kerberos SSO is **unreachable by adt-ls**
— it only speaks Basic / OAuth / SAML-reentrance over HTTP, and SNC secures the RFC/DIAG
channel, not HTTP (see `adt-ls-reference.md` + the `adt-ls-auth-kinds-boundary` finding;
Kerberos/SPNEGO also needs a paid SAP SSO license + a KDC). The one **license-free,
KDC-free, no-browser** alternative is **X.509 client certificates over HTTPS** — the same
mutual TLS the Cloud Connector already uses for Principal Propagation.

## Decision
Add a `clientcert` auth mode. The **existing reverse proxy (ADR-0005)** presents a client
cert on every upstream hop, so the **TLS connection itself authenticates the user** — no
credential in the logon flow:
- Library `clientCert({cert, key})` — a `LogonStrategy` that (a) carries the PEM cert/key
  (`createAdtLs` hands it to the proxy's upstream `https.request`) and (b) registers a
  reentrance handler that runs **with NO Authorization header**: the TLS cert authenticates
  the GET, so the backend issues the ticket for the cert-mapped user. Requires
  `connection.selfSigned` (the proxy does the mutual-TLS hop).
- arc-1-lsp `ARC1_SAP_AUTH=clientcert` + `ARC1_SAP_CLIENT_CERT` / `ARC1_SAP_CLIENT_KEY` —
  reads the PEM, builds `clientCert()`, forces `selfSigned`, keeps the headless keep-alive.

Server side (AS ABAP, **license-free**): `icm/HTTPS/verify_client=1` + the issuing CA
trusted in the SSL Server PSE + CERTRULE maps the cert subject's CN → user (by e-mail).
This is the **same machinery as Cloud-Connector PP** — no new server capability.

## Consequences
- **Fully headless + passwordless** — no browser, no password, no KDC, no license. Works on
  a server too (unlike `sso`).
- **Silent re-auth** — a lapsed session heals by re-presenting the cert (the library
  keep-alive), no browser pop, no human. Fixes the ~2-min-session annoyance.
- Reuses the reverse proxy (ADR-0005) + the reentrance flow (ADR-0006) almost entirely; the
  only new transport bit is the proxy's upstream client cert.
- **Gotchas (live-verified, cost hours):** the cert must be **encoded `/CN/OU/O/C`** so its
  RFC2253 subject matches the CERTRULE filter (SAP renders DNs reversed); the **ICM caches
  CERTRULE at SSL-logon**, so reload it (`kill icman`) after rule changes; the cert CN must
  equal the user's SU01 e-mail. The **macOS client needs nothing installed** (plain TLS).

## Revisit when
- adt-ls exposes a first-class client-cert / keystore auth kind → present the cert from
  adt-ls's own JVM directly (its Apache client already honors `useSystemProperties`, so
  `-Djavax.net.ssl.keyStore` would work) and drop the proxy-presents-cert indirection.
- A backend with a real (non-self-signed) cert → `clientcert` could connect direct (no
  proxy) once the cert is presented from the JVM keyStore.

# Passwordless logon with X.509 client certificates (`ARC1_SAP_AUTH=clientcert`)

This is the **headless, passwordless, no-browser** way to log arc-1-lsp on to an AS ABAP
system. arc-1-lsp presents an **X.509 client certificate** over mutual TLS; the backend
authenticates the TLS connection itself and maps the certificate to a SAP user — no
password, no browser pop, and re-auth on a lapsed session is silent.

It is the practical answer to *"can I get Kerberos / single-sign-on for adt-ls?"* — see
[Why X.509 and not Kerberos/SNC](#why-x509-and-not-kerberossnc).

---

## TL;DR

1. **Server (AS ABAP, one-time):** request client certs on the HTTPS port
   (`icm/HTTPS/verify_client = 1`), trust the issuing CA in **STRUST**, and add a
   **CERTRULE** rule that maps the certificate subject → a SAP user.
2. **Get a client certificate** whose subject maps to your user (see
   [Obtaining a client certificate](#obtaining-a-client-certificate)). You need it as two
   PEM files: the certificate and its private key.
3. **arc-1-lsp:**
   ```bash
   ARC1_SAP_AUTH=clientcert \
   ARC1_SAP_HOST=<host> ARC1_SAP_PORT=<https-port> ARC1_SAP_DESTINATION=<dest-id> \
   ARC1_SAP_CLIENT_CERT=/path/to/client.crt \
   ARC1_SAP_CLIENT_KEY=/path/to/client.key \
   node dist/index.js
   ```

There is **nothing to install on the client** — this is plain TLS handled by Node and the
JVM. (CommonCryptoLib, Kerberos libraries, a KDC, etc. are **not** needed.)

---

## How it works

```
arc-1-lsp ──TLS──► local reverse proxy ──mutual TLS (presents client cert)──► AS ABAP ICM
                                                                              │
                                          verify_client + STRUST trust + CERTRULE
                                                                              ▼
                                                               request runs as the mapped user
```

arc-1-lsp already routes adt-ls through a local TLS reverse proxy (it terminates the
self-signed-cert / hostname problem). In `clientcert` mode that proxy additionally
**presents your client certificate on every upstream connection** to the backend. The ICM
is configured to request a client certificate (`verify_client`), validates it against the
CAs trusted in **STRUST**, and a **CERTRULE** rule maps the certificate's subject to a SAP
user. Every request — including the logon handshake — is therefore authenticated as that
user with no credential in the application layer.

This is the **same mechanism SAP uses for Cloud Connector Principal Propagation** and for
SAP Web Dispatcher client-certificate logon — it is a standard, license-free AS ABAP
capability (see [References](#references)).

---

## Why X.509 and not Kerberos/SNC

Short version: **the ADT/`adt-ls` channel is HTTP, and `adt-ls` only speaks Basic / OAuth /
SAML-reentrance over HTTP.** It cannot do SNC or Kerberos/SPNEGO. Concretely:

- **SNC** (Secure Network Communications, incl. SNC-with-Kerberos) secures the **DIAG/RFC**
  transport — SAP GUI and JCo — **not** the HTTP channel ADT uses. Irrelevant to `adt-ls`.
- **Kerberos/SPNEGO over HTTP** *is* an AS ABAP capability, but it is part of the separately
  **licensed** SAP Single Sign-On / SAP Secure Login Service product and needs a **KDC**
  (Active Directory in every SAP-documented setup). `adt-ls` also ships no SPNEGO/`Negotiate`
  HTTP handler. See [SAP Note 1848999][note1848999] (licensing) and ADR-0009.
- **X.509 client certificates over HTTPS** need **no KDC and no license** for the
  encryption / server-authentication path, and the cert→user mapping (CERTRULE) is built in.

So X.509 client-cert is the one passwordless, headless, license-free mechanism that the ADT
HTTP stack can actually use. **In an enterprise this is not a downgrade from Kerberos** —
SAP's own **Secure Login Service** typically *converts* a Kerberos (or SAML) logon into a
short-lived X.509 client certificate, which is exactly what this mode consumes
([example][kerb2x509]).

---

## Server setup (AS ABAP, one-time)

You need administrator access to the SAP system. All of this is standard AS ABAP
configuration — references in the [References](#references) section.

### 1. Make the ICM request client certificates

In transaction **SMICM** (or the instance profile), on the **HTTPS** port set:

```ini
icm/HTTPS/verify_client = 1     # 1 = accept a client cert if presented; 2 = require one
# on the HTTPS server port, request the cert during the handshake:
icm/server_port_<n> = PROT=HTTPS, PORT=<https-port>, VCLIENT=1, ...
login/certificate = 1           # enable certificate logon
login/certificate_mapping_rulebased = 1   # use rule-based mapping (CERTRULE)
```

See *X.509 Client Certificate Authentication Method* and *Configuring the AS ABAP to Use
X.509 Client Certificates* ([References](#references)).

### 2. Trust the issuing CA (STRUST)

The CA that **issued your client certificate** must be in the **SSL server PSE**'s
certificate (trust) list, transaction **STRUST** → *SSL Server Standard* → import the CA
certificate → Save. (On systems where you only have shell access, `sapgenpse maintain_pk -a
<ca.crt> -p <SAPSSLS.pse>` adds it to the runtime PSE — back the PSE up first, and note that
some appliance images re-export the PSE from the database on restart, which reverts a
filesystem-only change.)

After changing trust, **restart/refresh the ICM** so it reloads the PSE (it caches SSL
material at startup) — e.g. *SMICM → Administration → ICM → Exit Soft*.

### 3. Map the certificate to a SAP user (CERTRULE)

Transaction **CERTRULE** (rule-based certificate mapping). Add a rule for **your CA** as the
issuer that extracts an attribute from the certificate **Subject** and maps it to a user:

| Field | Typical value |
|-------|---------------|
| Issuer | the DN of your CA |
| Entry / Source | `Subject` |
| Attribute | `CN` (or `E` / a Subject Alternative Name, per your cert convention) |
| Login As | `E-Mail Address` (matches the user's SU01 e-mail) — or `User ID` / `Alias` |
| Filter | `CN=*` (or a subject-DN pattern) |

With *Login As = E-Mail*, a certificate with `CN=<user-email>` maps to the SAP user whose
SU01 e-mail address is `<user-email>`. Make sure that user **has the e-mail set** (SU01 →
Address → E-Mail). CERTRULE also has a *Certificate Status based on Persistence* panel —
upload your **client** certificate there to verify it resolves to the right user before
testing arc-1-lsp.

> ⚠️ The ICM **caches CERTRULE at SSL-logon time** — after adding/changing a rule, restart
> the ICM (step 2) so it takes effect.

> ⚠️ **DN order gotcha** — SAP renders Distinguished Names in RFC2253 order (the reverse of
> the certificate's encoding). If the CERTRULE *Subject Filter* is a multi-RDN DN (e.g.
> `C=…,O=…,OU=…,CN=*`), the **client certificate must be encoded `/CN/OU/O/C`** so its
> RFC2253 subject matches the filter — otherwise CERTRULE reports *"Certificate not mapped"*
> and logon fails with `401`. A simple `CN=*` filter avoids this.

---

## Obtaining a client certificate

You need a certificate + private key (as **PEM files**) where:

- the **issuing CA is trusted** in STRUST (step 2), and
- the **subject maps to your user** via the CERTRULE rule (step 3).

### "SSO already just works for me in SAP GUI / Eclipse — where are my cert and key?"

**Usually there is no file you can point at — and that's by design.** Modern SAP single
sign-on ([SAP Secure Login Service][sls] / Secure Login Client) issues a **short-lived,
non-exportable** X.509 certificate *after* you authenticate, and the Secure Login Client
puts the private key in the operating system's **protected** store (Windows certificate
store / macOS Keychain), then **deletes it when the cert expires or the client closes**
([SAP][sls], [community][slcmac]). SAP GUI and Eclipse ADT use it transparently — you never
see, and cannot export, a `.crt`/`.key` pair. So `ARC1_SAP_CLIENT_CERT`/`_KEY` **cannot reuse
that everyday SSO certificate.**

What to do depends on **how your SSO actually works** — if unsure, ask your SAP Basis /
security team "how does ADT / HTTP logon authenticate?":

| Your SSO is… | Use this with arc-1-lsp |
|--------------|--------------------------|
| **Browser / SAML** (you get redirected to a web login page) | **`ARC1_SAP_AUTH=sso`** — the interactive browser flow, no cert files at all. This mirrors what your browser already does. |
| **SAP Secure Login Service / Client** (short-lived X.509, "just works" in SAP GUI) | the everyday cert is **non-exportable** → not usable as a static PEM. Get a **dedicated long-lived cert** (below), or use `sso` if the system also offers browser login. |
| **SNC / Kerberos** (SAP GUI logs you on with your Windows identity, no browser) | not usable by adt-ls at all — SNC is the SAP GUI/RFC channel, not HTTP. Use `sso`, or a dedicated cert. |

**Check what you actually have on your machine:**

- **macOS** — open *Keychain Access*, find the SAP / corporate certificate, expand it,
  right-click the **private key → Export "…"**. If Export is greyed out, the key is
  non-exportable (typical for SSO certs) → you cannot produce a PEM key.
- **Windows** — `certmgr.msc → Personal → Certificates`; you can only export the key if the
  cert was imported "with private key, mark as exportable".
- If **SAP Secure Login Client** is installed, assume your certs are short-lived and
  non-exportable.

**The clean path for a headless tool** (this is what to request): ask your **PKI / SAP Basis
team for a dedicated X.509 client certificate** issued for ABAP tool logon — with an
**exportable** private key, its subject mapped to your SAP user, the issuing CA trusted in
**STRUST**, and the **CERTRULE** rule added (the [server setup](#server-setup-as-abap-one-time)
above). They hand you a `.crt` + `.key` (or a `.p12` you split to PEM, [below](#b-enterprise)),
you point `ARC1_SAP_CLIENT_CERT`/`_KEY` at them, and you're done. (On macOS this is often the
*only* option anyway — SAP does not yet support short-lived Secure Login *Server* enrollment in
the Secure Login Client on Mac, [community][slcmac].)

### A. Local development / test (self-signed CA)

For a developer system you can mint your own CA and a client cert with `openssl`. Encode the
client subject `/CN/OU/O/C` to play nicely with multi-RDN CERTRULE filters (see the gotcha
above):

```bash
# 1. a throwaway dev CA (import ca.crt into STRUST + a CERTRULE rule for this issuer)
openssl req -x509 -newkey rsa:2048 -nodes -days 1825 \
  -keyout ca.key -out ca.crt -subj "/CN=my-dev-ca/OU=DEV/O=ACME/C=DE"

# 2. a client cert whose CN is the SAP user's e-mail (so CERTRULE Subject→CN→E-Mail maps it)
openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
  -subj "/CN=<user-email>/OU=DEV/O=ACME/C=DE"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -sha256 -out client.crt

# → ARC1_SAP_CLIENT_CERT=client.crt  ARC1_SAP_CLIENT_KEY=client.key
```

Keep `client.crt` / `client.key` somewhere durable (e.g. `~/.arc1-lsp/certs/`, **not**
`/tmp`), readable only by you (`chmod 600`).

### B. Enterprise

In an enterprise you normally do **not** mint your own CA — the certificate comes from
existing identity infrastructure, and the SAP admin trusts that infrastructure's CA in
STRUST once:

| Source | What it issues | Notes |
|--------|----------------|-------|
| **SAP Secure Login Service for SAP GUI** / **SAP Single Sign-On** (Secure Login Server) | short-lived X.509 client certs, often **derived from the user's Kerberos/AD or SAML logon** | the canonical SAP path; this is how "Kerberos SSO" becomes an X.509 cert ([example][kerb2x509]). Licensed product. |
| **Corporate PKI / Microsoft AD Certificate Services (AD CS)** | per-user (or per-device) certs via enrollment / GPO autoenrollment | stored in the OS certificate store |
| **SAP Cloud Identity Services – Identity Authentication (IAS)** | X.509 user certificates | for cloud-fronted scenarios |
| **Smartcard / PIV / hardware token** | a cert bound to a hardware token (PKCS#11) | not directly a file (see limitation below) |

**Where certs live, and getting them to PEM** (this mode reads PEM file paths):

- **macOS Keychain** — export the identity from *Keychain Access* (or `security
  export`/`find-identity`) to a `.p12`, then split to PEM:
  ```bash
  openssl pkcs12 -in identity.p12 -clcerts -nokeys -out client.crt
  openssl pkcs12 -in identity.p12 -nocerts  -nodes  -out client.key
  ```
- **Windows Certificate Store** — export the certificate **with the private key** to `.pfx`,
  then convert with the same `openssl pkcs12` commands.
- **PKCS#12 / `.pfx`** bundles from any PKI — convert as above.
- **HSM / smartcard (PKCS#11)** and **short-lived auto-renewed certs** are **not** usable as
  static PEM files today. For those you'd export/stage a PEM out-of-band, or extend
  `clientCert()` (it accepts cert/key material) to fetch/renew — see *Limitations*.

Whatever the source, the only hard requirements are the two server-side facts: the
**issuing CA is trusted in STRUST**, and a **CERTRULE rule maps the subject to your user**.

---

## arc-1-lsp configuration

| Env var / flag | Required | Description |
|----------------|----------|-------------|
| `ARC1_SAP_AUTH` / `--sap-auth` | `clientcert` | selects this mode |
| `ARC1_SAP_HOST` / `--sap-host` | ✓ | backend host |
| `ARC1_SAP_PORT` / `--sap-port` | ✓ | backend **HTTPS** port |
| `ARC1_SAP_CLIENT_CERT` / `--sap-client-cert` | ✓ | PEM client-certificate file path |
| `ARC1_SAP_CLIENT_KEY` / `--sap-client-key` | ✓ | PEM private-key file path |
| `ARC1_SAP_DESTINATION` / `--sap-destination` | — | adt-ls destination id (default `SAP`) |
| `ARC1_SAP_CLIENT` / `--sap-client` | — | SAP client (default `001`) |
| `ARC1_SAP_USER` / `--sap-user` | — | optional destination hint only; the real user comes from the cert mapping |

> **Don't have a `.crt` / `.key` pair?** If your enterprise SSO already "just works" in SAP
> GUI / Eclipse, that certificate usually **cannot** be used here (it's short-lived and
> non-exportable) — see [Obtaining a client certificate](#obtaining-a-client-certificate).

No `ARC1_SAP_PASSWORD` is used. `ARC1_SAP_INSECURE` is forced on in this mode (the reverse
proxy does the mutual-TLS hop). In Cursor / Claude Desktop / VS Code, set the same
`ARC1_SAP_*` keys in the MCP server's `env`.

Startup logs `engine: client-cert mode — passwordless X.509 mutual TLS (no browser, silent
re-auth).` and then `engine: connected destination <id>`.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| TLS handshake fails / `HTTP 000` with the cert | the issuing CA is **not trusted** in STRUST (or ICM not reloaded after adding it) |
| `HTTP 401` "Anmeldung fehlgeschlagen" **with** the cert | the cert is accepted at TLS but **not mapped** — no CERTRULE rule for this issuer, the *Subject Filter* doesn't match (see the DN-order gotcha), or the mapped e-mail/user doesn't exist |
| `HTTP 401` **without** the cert (negative control) | expected — proves the endpoint requires auth |
| Works, then breaks after a server restart | a **filesystem-only** PSE trust change was reverted on restart — re-import the CA (prefer STRUST / DB, or re-run the `sapgenpse` step) |

Use the CERTRULE *Certificate Status based on Persistence* panel with your **client** cert
to see exactly which rule matched and which user it resolved to.

---

## Limitations

- **Static PEM files only.** Short-lived / auto-renewed certs (Secure Login Service),
  OS-keychain identities, and HSM/smartcard (PKCS#11) keys must be exported/staged to PEM
  first. A renewal hook is out of scope for this mode today.
- **Requires the local reverse proxy** (`selfSigned`), which presents the cert upstream.
  Direct presentation from adt-ls's own JVM keystore (no proxy) is a possible future
  simplification — its HTTP client honors `-Djavax.net.ssl.keyStore` — but is not wired yet
  (see ADR-0009 *Revisit when*).

---

## References

SAP product documentation:

- [X.509 Client Certificate Authentication Method (ABAP Platform)][x509method]
- [Configuring the AS ABAP to Use X.509 Client Certificates][configx509]
- [Rule-Based Certificate Mapping — transaction CERTRULE][certrule]
- [Forward SSL Certificates for X.509 Authentication (reverse proxy / Web Dispatcher)][forwardssl]
- [SAP Note 1848999 — CommonCryptoLib central note (licensing: encryption/server-auth is free; user-SSO via Kerberos/X.509 needs SAP SSO / Secure Login Service)][note1848999]
- [SAP Secure Login Service for SAP GUI][sls] — short-lived, non-exportable X.509 certs for SSO (and the [macOS Secure Login Client limitation][slcmac])

Worked examples / background:

- [How to enable SSO using X.509 client certificates in the ABAP application server][howtox509]
- [Reusing a Kerberos token to issue X.509 client certificates with Secure Login Server][kerb2x509]
- [X.509-based logon (1): configure the ICM to accept client certificates][itsfullofstars]

Internal: [ADR-0009](adr/0009-client-cert-auth.md) (decision) · `adt-ls-reference.md` §10
(adt-ls auth boundary + the proven recipe).

[x509method]: https://help.sap.com/docs/ABAP_PLATFORM_NEW/68bf513362174d54b58cddec28794093/bb5d22518bc72214e10000000a44176d.html
[configx509]: https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/d528eef3dca14679bcb47b069aa17a9d/4e1260981e3d2287e10000000a15822b.html
[certrule]: https://help.sap.com/docs/ABAP_PLATFORM_NEW/e815bb97839a4d83be6c4fca48ee5777/c830fd902dc8473b9e59db1576cc784b.html
[forwardssl]: https://help.sap.com/docs/ABAP_PLATFORM_NEW/683d6a1797a34730a6e005d1e8de6f22/2a6cec67c50842aab1444f7dfd0257e1.html
[note1848999]: https://me.sap.com/notes/1848999
[howtox509]: https://community.sap.com/t5/technology-blog-posts-by-sap/how-to-enable-sso-using-x-509-client-certificates-in-abap-app-server/ba-p/13182918
[kerb2x509]: https://community.sap.com/t5/technology-blog-posts-by-sap/reusing-kerberos-token-for-issuing-x-509-client-certificates-with-secure/ba-p/13132812
[itsfullofstars]: https://www.itsfullofstars.de/2020/07/x509-based-logon-1-configure-icm-to-accept-client-certificates/
[sls]: https://help.sap.com/docs/secure-login-service-for-sap-gui
[slcmac]: https://answers.sap.com/questions/12010479/sap-secure-login-client-on-mac-with-x509.html

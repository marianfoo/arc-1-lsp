# adt-ls native dependencies (Debian slim)

The headless `adt-ls` (SAP Machine JRE 21 + Eclipse/SWT-gtk) needs a few system
libraries on `node:22-slim` (Debian bookworm). The set below is **verified
working** — the container boots adt-ls, registers all 14 MCP tools, and serves
`/mcp` end-to-end on `linux/amd64`.

```
ca-certificates    # TLS to SAP backends
fontconfig         # JRE AWT font subsystem
libfreetype6       # font rendering
libgtk-3-0         # SWT/gtk (some ADT plugins load SWT even headless)
libx11-6 libxext6 libxrender1 libxtst6 libxi6   # X libs SWT links against
```

Verified 2026-05-29 on `node:22-slim` under arm64→amd64 emulation: adt-ls
`initialize` + `startMCPServer` + `tools/list` (14) all succeed inside the
container, no missing-library errors in the logs.

Not yet minimized — the gtk/X set is likely larger than a pure-headless LSP
strictly needs; trimming is a future optimization (verify each removal against a
clean container boot).

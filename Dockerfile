# arc-1-lsp container image (linux/amd64 for BTP CF).
#
# Host-built dist + prod node_modules keep the image arch-clean: all our deps are
# pure JS (no native node modules), so they're copied/installed without
# emulation cost. The only amd64-native payload is the BYO adt-ls (x86_64) under
# vendor/adt-ls — injected at build time, never committed/redistributed.
FROM node:22-slim

# Native libs the headless adt-ls (SAP Machine JRE + Eclipse/SWT-gtk) needs on
# Debian slim. Refined empirically; see docs/native-deps.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fontconfig \
      libfreetype6 \
      libgtk-3-0 \
      libx11-6 \
      libxext6 \
      libxrender1 \
      libxtst6 \
      libxi6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prod dependencies (pure JS — installs fine under emulation, no native build).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Host-built output + the BYO adt-ls (run `npm run build` + extract-adt-ls.mjs first).
# adt-ls (big, stable) before dist (small, changes often) for layer-cache reuse.
COPY vendor/adt-ls ./vendor/adt-ls
COPY dist ./dist

# Do NOT bake ARC1_PORT: on CF the app must listen on the assigned $PORT.
# Locally, config falls back to 8080 (matches EXPOSE) when neither is set.
ENV ARC1_TRANSPORT=http-streamable \
    ARC1_ADT_LS_PATH=/app/vendor/adt-ls/linux/gtk/x86_64/adt-ls

EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]

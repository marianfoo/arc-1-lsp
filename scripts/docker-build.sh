#!/usr/bin/env bash
# Build the arc-1-lsp linux/amd64 image for BTP CF.
# Host-builds dist (pure JS) and ensures the BYO adt-ls is extracted, then
# assembles the amd64 image. Requires a buildx builder with linux/amd64.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-arc-1-lsp:dev}"

echo "==> host build (tsc → dist/)"
npm run build

echo "==> ensure BYO linux adt-ls is staged (vendor/adt-ls/)"
if [ ! -x vendor/adt-ls/linux/gtk/x86_64/adt-ls ]; then
  node scripts/extract-adt-ls.mjs
fi

echo "==> docker buildx build --platform linux/amd64 -t ${IMAGE}"
docker buildx build --platform linux/amd64 -t "${IMAGE}" --load .

echo "==> done: ${IMAGE}"

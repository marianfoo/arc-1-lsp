#!/usr/bin/env bash
# Smoke-test a running arc-1-lsp MCP endpoint (local or BTP CF).
# The endpoint is stateless StreamableHTTP, so a bare tools/call works — no
# session handshake needed.
#
# Usage:
#   ARC1_URL=https://arc-1-lsp.cfapps.us10-001.hana.ondemand.com/mcp \
#   ARC1_KEY=<api-key> bash scripts/smoke-remote.sh
#
# ARC1_KEY is optional (omit if the endpoint has no API key, e.g. local dev).
set -euo pipefail

URL="${ARC1_URL:?set ARC1_URL to the /mcp endpoint}"
KEY="${ARC1_KEY:-}"

hdr=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
[ -n "$KEY" ] && hdr+=(-H "Authorization: Bearer $KEY")

# StreamableHTTP replies as SSE (data: <json>) or plain JSON — unwrap either.
unwrap() {
  local body
  body=$(cat)
  if printf '%s' "$body" | grep -q '^data: '; then
    printf '%s' "$body" | grep '^data: ' | sed 's/^data: //' | tail -1
  else
    printf '%s' "$body"
  fi
}

call() { # $1=jsonrpc body
  curl -sS "${hdr[@]}" "$URL" -d "$1" | unwrap
}

echo "== /healthz (no auth) =="
curl -sS "${URL%/mcp}/healthz" && echo

echo "== health tool =="
call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health","arguments":{}}}'

echo "== tools/list =="
call '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

echo "== list_creatable_objects (real backend call — needs a connected destination) =="
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_creatable_objects","arguments":{}}}'

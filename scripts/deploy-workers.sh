#!/usr/bin/env bash
# Deploy chat-worker + frontend (worker name: chat) to the demo ns, in order: chat-worker
# first, then frontend (which re-pins its CHAT service binding to the freshly
# deployed chat-worker version). Regenerates agents-md.gen.js first so any
# agents-md.md edit ships in this run.
#
# The MicroVM sandbox image is NOT built here — Lambda builds it from
# docker/Dockerfile.microvm. The broker (workers/sandbox-broker) is deployed
# separately (`npm run deploy:sandbox-broker`) since it rarely changes and
# carries the AWS key as a worker secret.
#
# Auth: uses the wdl-cli token store, resolved per --ns. Run the one-time
# `wdl token` setup so `--ns demo` finds a credential + control URL.
#
# Env:
#   WDL_NS    target ns (default: demo)
#   WDL_BIN   the wdl CLI to invoke (default: `wdl` on PATH; `npm i -g @wdl-dev/cli`)
# Skip: WDL_DEPLOY_SKIP=chat | frontend.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

WDL_NS="${WDL_NS:-demo}"
SKIP="${WDL_DEPLOY_SKIP:-}"
WDL_BIN="${WDL_BIN:-wdl}"

if ! command -v "$WDL_BIN" >/dev/null 2>&1 && [[ ! -x "$WDL_BIN" ]]; then
  echo "FATAL: wdl CLI not found ($WDL_BIN)" >&2
  echo "  install it with: npm i -g @wdl-dev/cli   (or set WDL_BIN)" >&2
  exit 1
fi

echo "==> regenerating agents-md.gen.js"
node "$ROOT/scripts/build-agents-md.mjs"

if [[ "$SKIP" != "chat" ]]; then
  echo "==> wdl deploy workers/chat (ns=$WDL_NS)"
  ( cd "$ROOT/workers/chat" && "$WDL_BIN" deploy . --ns "$WDL_NS" )
fi

if [[ "$SKIP" != "frontend" ]]; then
  echo "==> wdl deploy workers/frontend (re-pins CHAT binding)"
  ( cd "$ROOT/workers/frontend" && "$WDL_BIN" deploy . --ns "$WDL_NS" )
fi

echo
echo "==> done"

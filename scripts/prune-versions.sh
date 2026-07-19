#!/usr/bin/env bash
# Keep the newest N versions of a worker (default 3) and delete the rest.
#
# Nothing here ever exits non-zero — not a failed delete, not a bad config. This runs after a deploy
# that already succeeded remotely, so failing would only make CI retry work that landed. A version
# another worker's binding still pins answers `409 version_referenced`, which is the correct answer,
# not an error; the next deploy's prune retries it.
#
# The active version is always kept even if it is not among the newest N (possible after a rollback).
#
# --ns is REQUIRED: callers must pass the same namespace they deployed to, so a prune can never read
# one namespace's listing after deploying to another.
#
# Usage:  scripts/prune-versions.sh <worker> --ns <ns> [--keep N]
# Env:    WDL_BIN (default `wdl`), WDL_PRUNE_KEEP (default 3) — the env var is the way to change
#         retention for a whole deploy chain, since `--keep` only reaches one invocation.

set -uo pipefail   # no -e on purpose; see the exit-code note above

skip() { echo "    prune: $*" >&2; exit 0; }

WORKER="" NS="" KEEP="${WDL_PRUNE_KEEP:-3}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ns)
      [[ $# -ge 2 ]] || skip "missing value for --ns — skipped"
      NS="$2"; shift 2 ;;
    --keep)
      [[ $# -ge 2 ]] || skip "missing value for --keep — skipped"
      KEEP="$2"; shift 2 ;;
    -*) skip "unknown option $1 — skipped" ;;
    *) WORKER="$1"; shift ;;
  esac
done
WDL_BIN="${WDL_BIN:-wdl}"

[[ -n "$WORKER" && -n "$NS" ]] || skip "usage: prune-versions.sh <worker> --ns <ns> [--keep N] — skipped"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || skip "retention must be a positive integer (got '$KEEP') — skipped"

LISTING="$("$WDL_BIN" workers --ns "$NS" --json 2>/dev/null)" || {
  skip "could not list $NS workers — skipped"
}

# Prints the versions to delete, or exits non-zero so a parse failure can't look like "nothing to do".
# shellcheck disable=SC2016  # single quotes are deliberate: this is JS for node -e, not shell to expand
DOOMED="$(printf '%s' "$LISTING" | KEEP="$KEEP" WORKER="$WORKER" node -e '
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const keep = Number(process.env.KEEP);
  const want = process.env.WORKER;
  const workers = JSON.parse(raw).workers;
  if (!Array.isArray(workers)) throw new Error("listing has no workers[]");
  const w = workers.find((x) => x && x.name === want);
  if (!w) throw new Error(`worker ${want} not found in ns listing`);
  const num = (v) => Number(String(v).replace(/\D/g, "")) || 0;
  const versions = [...(w.versions || [])].sort((a, b) => num(a) - num(b));
  const survivors = new Set([...versions.slice(-keep), w.activeVersion]);
  process.stdout.write(versions.filter((v) => !survivors.has(v)).join("\n"));
});
' 2>&1)" || {
  skip "$WORKER — could not read version list: $(printf '%s' "$DOOMED" | grep -oE '(Error|SyntaxError): .*' | head -1)"
}

if [[ -z "$DOOMED" ]]; then
  echo "    prune: $WORKER already within $KEEP versions"
  exit 0
fi

DELETED=0 PINNED=0
while IFS= read -r v; do
  [[ -z "$v" ]] && continue
  if OUT="$("$WDL_BIN" delete version "$WORKER" "$v" --ns "$NS" 2>&1)"; then
    DELETED=$((DELETED + 1))
  elif [[ "$OUT" == *version_referenced* ]]; then
    PINNED=$((PINNED + 1))
  else
    echo "    prune: $WORKER@$v not deleted — $(printf '%s' "$OUT" | tail -1)" >&2
  fi
done <<< "$DOOMED"

echo "    prune: $WORKER kept newest $KEEP, deleted $DELETED$([[ $PINNED -gt 0 ]] && echo ", $PINNED still pinned")"
exit 0

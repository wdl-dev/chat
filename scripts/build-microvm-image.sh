#!/usr/bin/env bash
# Rebuild the wdl-chat sandbox MicroVM image (AWS Lambda MicroVMs).
#
# The image installs @wdl-dev/cli from npm + bakes sandbox-agent; the workers (chat-worker /
# chat / sandbox-broker) are separate `wdl deploy`s and do NOT need this.
# AGENTS.md / prompt edits are also just `wdl deploy chat-worker` (injected at
# runtime), not an image rebuild.
#
# Usage:
#   bash scripts/build-microvm-image.sh                       # defaults below
#   CLI_TAG=1.4.0 MIN_MEM_MIB=1024 bash scripts/build-microvm-image.sh
#   DRY_RUN=1 bash scripts/build-microvm-image.sh             # zip only, no AWS calls
#
# Env (all overridable; defaults target the demo account):
#   CLI_TAG       @wdl-dev/cli version for the image DESCRIPTION only — the real pin is the
#                 `npm install @wdl-dev/cli@X` line in docker/Dockerfile.microvm
#   MIN_MEM_MIB   per-VM base memory floor (default 512)
#   AWS_PROFILE   from your environment (not defaulted);  AWS_REGION ap-northeast-1;
#                 AWS_ACCOUNT_ID auto-derived from the caller (override to retarget)
# Needs aws-cli >= 2.35 (the `lambda-microvms` command group) and python3.
#
# minMem is only the BASE: a VM bursts to a peak (~4GB/2vCPU) on demand, so even
# a 512MiB base builds fine (esbuild/wrangler burst above it). vCPU is
# proportional to memory (~1 vCPU / 1769 MiB); there is no separate CPU knob.
#
# QUOTA: the account "Max allocated memory" cap counts ~peak per VM; SUSPENDED
# VMs still hold it. When `openSession` fails 402 "base maximum allocated memory
# limit", free it:
#     aws lambda-microvms list-microvms          # response key is `items`
#     aws lambda-microvms terminate-microvm --microvm-id <id>   # the SUSPENDED ones
# (RunMicrovm rate may also be throttled below the default 5 — a separate quota.)
#
# `update-microvm-image` (NOT create — create rejects an existing name). Omit
# --base-image-version (0.0 errors). On FAILED the prior active version stays
# live, so a bad build can't break prod. After a SUCCESSFUL build, e2e a real
# session (a returned preview URL = healthy).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

CLI_TAG="${CLI_TAG:-1.3.1}"   # description only — keep in sync with the pin in docker/Dockerfile.microvm
MIN_MEM_MIB="${MIN_MEM_MIB:-512}"
export AWS_REGION="${AWS_REGION:-ap-northeast-1}"
# AWS_PROFILE / credentials come from your environment — not defaulted here.
if [ -n "${AWS_PROFILE:-}" ]; then export AWS_PROFILE; fi
# Account-specific ARNs/bucket derive from the caller's account — no hardcoded ID.
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)}"
IMAGE_ARN="${IMAGE_ARN:-arn:aws:lambda:$AWS_REGION:$ACCOUNT_ID:microvm-image:wdl-chat-sandbox}"
BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-arn:aws:lambda:$AWS_REGION:aws:microvm-image:al2023-1}"
BUILD_ROLE_ARN="${BUILD_ROLE_ARN:-arn:aws:iam::$ACCOUNT_ID:role/wdl-chat-microvm-build}"
S3_URI="${S3_URI:-s3://wdl-chat-microvm-$ACCOUNT_ID-apne1/microvm-artifact.zip}"
EGRESS_CONNECTOR="${EGRESS_CONNECTOR:-arn:aws:lambda:$AWS_REGION:aws:network-connector:aws-network-connector:INTERNET_EGRESS}"
DESCRIPTION="${DESCRIPTION:-CLI $CLI_TAG; ${MIN_MEM_MIB} MiB base}"

cd "$ROOT"
echo "==> build artifact zip (no zip binary → python)"
ART="$(mktemp -t microvm-artifact.XXXXXX).zip"
python3 - "$ART" <<'PY'
import zipfile, os, sys
out = sys.argv[1]
EXC = {"node_modules", ".git"}
skip = lambda p: any(x in EXC for x in p.split(os.sep)) or p.split(os.sep)[-1].startswith((".env", ".dev.vars"))
n = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.write("docker/Dockerfile.microvm", "Dockerfile"); n += 1
    for top in ("sandbox-agent",):
        for root, dirs, files in os.walk(top):
            dirs[:] = [d for d in dirs if d not in EXC]
            for f in files:
                p = os.path.join(root, f)
                if not skip(p):
                    z.write(p, p); n += 1
print(f"    {n} entries, {os.path.getsize(out)//1024} KiB")
PY

if [ -n "${DRY_RUN:-}" ]; then
  echo "==> DRY_RUN set — zip kept at $ART; skipping upload + update-microvm-image"
  exit 0
fi

[ -n "$ACCOUNT_ID" ] || { echo "FATAL: could not resolve AWS account — set AWS_ACCOUNT_ID or check credentials" >&2; exit 1; }

echo "==> upload → $S3_URI"
aws s3 cp "$ART" "$S3_URI" >/dev/null
rm -f "$ART"

echo "==> update-microvm-image (minMem=$MIN_MEM_MIB)"
VERSION=$(aws lambda-microvms update-microvm-image \
  --image-identifier "$IMAGE_ARN" \
  --base-image-arn "$BASE_IMAGE_ARN" \
  --build-role-arn "$BUILD_ROLE_ARN" \
  --code-artifact "uri=$S3_URI" \
  --egress-network-connectors "$EGRESS_CONNECTOR" \
  --resources "minimumMemoryInMiB=$MIN_MEM_MIB" \
  --description "$DESCRIPTION" \
  --query imageVersion --output text)
echo "    building v$VERSION (~2.5 min; FAILED leaves the prior active version live)"

echo "==> poll until terminal"
STATE="" IMG_STATUS=""
for i in $(seq 1 40); do
  read -r STATE IMG_STATUS < <(aws lambda-microvms get-microvm-image-version \
    --image-identifier "$IMAGE_ARN" --image-version "$VERSION" \
    --query '[state,status]' --output text 2>/dev/null || echo "? ?")
  echo "    poll $i: state=$STATE status=$IMG_STATUS"
  case "$STATE" in SUCCESSFUL|FAILED|CANCELLED) break ;; esac
  sleep 15
done

if [ "$STATE" = "SUCCESSFUL" ]; then
  echo "==> v$VERSION SUCCESSFUL + $IMG_STATUS. Broker pins by name → uses it on the next new session (no broker redeploy). Now e2e a real session."
else
  echo "==> v$VERSION ended $STATE — prior active version unchanged. Inspect: aws lambda-microvms get-microvm-image-build --image-identifier $IMAGE_ARN --image-version $VERSION" >&2
  exit 1
fi

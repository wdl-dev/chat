# wdl-chat

[![CI](https://github.com/wdl-dev/chat/actions/workflows/ci.yml/badge.svg)](https://github.com/wdl-dev/chat/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English | [中文](README-zh.md)

**A WDL Worker that builds WDL Workers.** wdl-chat is an AI agent — itself
deployed on WDL — that turns one line into a running worker: build inside a
MicroVM sandbox → deploy to a throwaway namespace → debug and preview.

This is **not** platform code — it's a product that runs **as a tenant on the WDL
platform**, the same way any other tenant would. It uses the open-source
[`@wdl-dev/cli`](https://github.com/wdl-dev/cli) CLI (`npm i -g @wdl-dev/cli`); the platform
itself is [wdl-dev/wdl](https://github.com/wdl-dev/wdl). Live at
**https://chat.wdl.dev**.

> **Status — reference demo, not a hardened production service.** This is a
> best-effort showcase of building a real product on WDL. It's deployed and it
> works, but it is maintained as a demo: the unit suite covers the core logic
> (parsing, the run state machine, the command guards, idempotency) rather than
> exhaustively, the Durable Object and in-VM HTTP handlers have no direct test
> harness, and a few rough edges are tracked as known limitations instead of fixed.
> Learn from it — don't treat it as a turnkey production template.

Open source under Apache-2.0 — see [LICENSE](LICENSE). The workspace packages are marked
`private`: the source is open, but nothing is published to npm. Bundled
third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Repository layout

```text
sandbox-agent/        HTTP server (Node) inside each per-session MicroVM. Lambda
                      builds the image from docker/Dockerfile.microvm; this code
                      runs inside that image.
workers/
  sandbox-broker/     demo ns; stateless RPC broker (open/mint/close a per-session
                      Lambda MicroVM) — the only component holding the AWS key.
  chat/               demo ns; chat-worker — ChatSessionDO + ChatRunWorkflow
                      agent loop + LLM (DeepSeek).
  frontend/           demo ns (worker name = chat); single-page frontend (WebSocket-preferred, SSE fallback) that
                      serves chat.wdl.dev.
docker/Dockerfile.microvm   MicroVM image definition (built by AWS Lambda, not
                            local docker).
scripts/              bootstrap, deploy-workers, build-agents-md, build-microvm-image.
tests/e2e/            live-stack e2e (unit tests live beside each worker).
```

## Design docs

`CLAUDE.md` is the source of truth for the current architecture, design
decisions, security boundaries, debugging entry points, and an ops cheat-sheet —
read it first. Contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Execution model

Each session gets its own Lambda MicroVM (Firecracker, Tokyo). On the first tool
use, chat-worker calls `sandbox-broker.openSession` over the `BROKER` JSRPC
service binding: the broker uses its AWS key to launch a MicroVM, mint a
short-lived JWE, push the session context to the in-VM sandbox-agent's `/init`,
and hand `{ endpoint, authToken }` back. chat-worker then talks to the MicroVM's
public HTTPS endpoint directly (with `X-aws-proxy-auth`) to run commands and
deploy. On close, `broker.closeSession` terminates the VM. No standing pool, no
leases, no mesh.

## Deploy

You need two credentials from your WDL platform operator: (1) a normal per-ns token for the
`demo` ns (your deploy credential), and (2) a delegated `token-issuer` credential.

```text
0. npm i -g @wdl-dev/cli && wdl token   # install the CLI + register the demo-ns token (cred 1)
1. TOKEN_ISSUER_TOKEN=<delegated issuer> npm run bootstrap
                                        # apply chat-db migrations + store cred 2 as a chat-worker secret
2. npm run deploy:sandbox-broker     # deploy the broker
   echo -n <id>  | wdl secret put AWS_ACCESS_KEY_ID --worker sandbox-broker --ns demo
   echo -n <key> | wdl secret put AWS_SECRET_ACCESS_KEY --worker sandbox-broker --ns demo
   echo -n <arn> | wdl secret put MICROVM_IMAGE_ARN --worker sandbox-broker --ns demo  # name-based ARN, see "built separately" below
3. set chat-worker secrets (--worker chat-worker --ns demo):
   OPERATOR_TOKEN / LLM_API_KEY / ADMIN_URL / DEMO_PASSCODE   (TOKEN_ISSUER_TOKEN was set in step 1)
4. bash scripts/deploy-workers.sh    # deploy chat-worker, then frontend (re-pins the CHAT binding)
5. open https://chat.wdl.dev/
```

The sandbox image is built separately: `bash scripts/build-microvm-image.sh`
(zip → `update-microvm-image`; the CLI is installed from npm inside the image). `deploy:chat` /
`deploy:frontend` can be run individually, but the frontend must be redeployed
*after* chat-worker to re-pin its service binding to the new version.


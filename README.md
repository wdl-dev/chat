# wdl-chat

[![CI](https://github.com/wdl-dev/chat/actions/workflows/ci.yml/badge.svg)](https://github.com/wdl-dev/chat/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

English | [中文](README-zh.md)

**A WDL Worker that builds WDL Workers.** wdl-chat is an AI agent — itself
deployed on WDL — that turns one line into a running worker: build inside a
MicroVM sandbox → deploy to a throwaway namespace → debug and preview.

This is **not** platform code — it's a dogfooding application that runs **as a
tenant on the WDL platform**, the same way any other tenant would. It uses
the open-source [`@wdl-dev/cli`](https://github.com/wdl-dev/cli) CLI
(`npm i -g @wdl-dev/cli`); the platform itself is
[wdl-dev/wdl](https://github.com/wdl-dev/wdl) — main site
[wdl.dev](https://wdl.dev/), docs for every [wdl-dev](https://github.com/wdl-dev)
repository aggregated at [wdl.md](https://wdl.md/). Live at
**https://chat.wdl.dev**.

> **Status — reference demo, not a hardened production service.** This is a
> best-effort demonstration of building a real application on WDL — an
> extensive dogfooding exercise, and it will stay in that stage. It's deployed
> and it works, but it is maintained as a demo: the unit suite covers the core
> logic (parsing, the run state machine, the command guards, idempotency)
> rather than exhaustively, the Durable Object and in-VM HTTP handlers have no
> direct test harness, and a few rough edges are tracked as known limitations
> instead of fixed. The known security boundaries are documented in the design
> docs. It is useful as a reference for the moving parts, not as a turnkey
> production template.

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
                      agent loop + LLM (Anthropic- or OpenAI-shaped provider, secret-configurable).
  frontend/           demo ns (worker name = chat); single-page frontend (WebSocket-preferred, SSE fallback) that
                      serves chat.wdl.dev.
docker/Dockerfile.microvm   MicroVM image definition (built by AWS Lambda, not
                            local docker).
scripts/              bootstrap, deploy-workers, build-agents-md, build-microvm-image,
                      prune-versions.
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
deploy. On close, `broker.closeSession` terminates the VM. Sessions also have a
hard 6-hour lifetime (the ns-token TTL): past it the router lazily expires the
session on the next request (gated writes get `410`, stream/export `404`) and the
VM's own 6h max-lifetime reaps it. No standing pool, no leases, no mesh.

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
   # EXA_API_KEY (optional) backs the web_search / web_fetch tools; unset, they answer "not configured".
   # LLM_API_KEY must match the default provider (DeepSeek, Anthropic wire). For a different
   # provider set the whole LLM_* group together: LLM_API_SHAPE / LLM_BASE_URL / LLM_MODEL /
   # LLM_MODEL_LITE (+ LLM_MAX_TOKENS_PARAM=max_completion_tokens for OpenAI reasoning models —
   # the default max_tokens 400s them). A bare key with no overrides is sent to DeepSeek.
4. bash scripts/deploy-workers.sh    # deploy chat-worker, then frontend (re-pins the CHAT binding)
5. open https://chat.wdl.dev/
```

The sandbox image is built separately: `bash scripts/build-microvm-image.sh`
(zip → `update-microvm-image`; the CLI is installed from npm inside the image). `deploy:chat` /
`deploy:frontend` can be run individually, but the frontend must be redeployed
*after* chat-worker to re-pin its service binding to the new version.

Every deploy path then runs `scripts/prune-versions.sh`, which **irreversibly deletes** all but the
newest 3 versions (the active one is always kept). It is best effort — a version another worker still
pins is left alone and retried next deploy, and no prune failure (including a bad config) ever fails
the deploy. Set `WDL_PRUNE_KEEP=N` for a different retention — it applies to every prune in the
chain, whereas `--keep` only reaches one — or call `wdl deploy` directly to skip pruning.


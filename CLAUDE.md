# CLAUDE.md

## Project Overview

wdl-chat is an AI-driven WDL Worker development platform built **on top of** the WDL
self-hosted Workers platform. Users describe a Worker in
chat; an LLM agent writes code in a per-session sandbox MicroVM, deploys it to a tmp
namespace via `deploy_test`, and shows a preview iframe. This project is just a tenant of
the platform — it deploys to the regular `demo` ns and uses the open-source CLI
(`@wdl-dev/cli`, github.com/wdl-dev/cli) like any other tenant. The platform repo
([wdl-dev/wdl](https://github.com/wdl-dev/wdl); its docs are the platform-mechanics
source of truth — re-read them rather than duplicating here) runs the control plane at
**api.wdl.dev**, serves tenant workers at **\*.wdl.sh**, and this app at **chat.wdl.dev**.

## Architecture

Three workers, all in the `demo` ns (regular user-runtime tenant), plus the in-VM agent:

- **`workers/chat/`** — chat-worker. HTTP entry plus a SQLite-backed `ChatSessionDO` per
  session. The DO holds messages + steps + runs in `ctx.storage.sql`; a
  cross-DO catalog (`sessions_index`) lives in shared D1 (`chat-db`). Each session mints a
  fresh tmp namespace + ns token at start via auth's `/auth/delegated-tokens` (no
  preallocated pool). The session id is a random `crypto.randomUUID()` bearer the client
  holds (URL hash + localStorage) and presents on every `/api/sessions/:id/*` call — it is
  NOT the ns and is never published; the ns is only the public preview host (`<ns>.wdl.sh`).
  Keeping the two decoupled is a security invariant: if the session id were the ns, a
  shared preview URL would hand over session control. The LLM agent loop runs as a **WDL Workflow**
  (`ChatRunWorkflow`, `src/workflow.js`); the DO is the storage/broadcast/JSRPC boundary
  and the per-step bodies (`workflowExecuteLlmTurn` / `workflowRunToolBatch` /
  `workflowDraftPlan` / `workflowRevisePlan`). JSRPC `addUserMessage` /
  `cancelLatestRun` / `requestClose`; `GET /stream` is WebSocket-preferred with SSE
  fallback (both replay history + live; WS keepalive via auto-response ping/pong, SSE via
  a 25s server heartbeat).
- **`workers/frontend/`** — chat-frontend (worker name `chat`). Static SPA under
  `public/`, plus a thin `src/worker.js` that serves the SPA at `/` and proxies `/api/*`
  → `env.CHAT.fetch()` (service binding to chat-worker). Served at **chat.wdl.dev** via a
  declared pattern host (`routes: ["chat.wdl.dev/*"]`; the host is pre-declared with
  `POST /ns/demo/hosts`). The pattern branch does NOT strip the path, so the SPA must use
  absolute `/api/...` URLs.
- **`workers/sandbox-broker/`** — the Lambda MicroVM lifecycle broker. A stateless,
  RPC-only `WorkerEntrypoint` (`Broker`) exposing `openSession` / `mintToken` /
  `closeSession` over the `BROKER` service binding. It is the **only** holder of the AWS
  IAM key (its own per-worker secret). No DO, no routes — the binding is the capability.
  Per-session state (`{ microvmId, endpoint, authToken }`) lives in chat-worker's
  ChatSessionDO, not here.
- **`sandbox-agent/`** — the HTTP server (port 8080) that runs inside each
  MicroVM (tini is PID 1). One MicroVM == one session, bound via `POST /init`. It runs as root and drops
  AI subprocesses to the single `sandbox` uid (2000) via `gosu`. The ns token is not a
  hidden secret: it arrives at runtime via `/init` (JS heap) and is deliberately handed
  to each AI command's child env as `ADMIN_TOKEN` (AI-visible by design) — the boundary is the VM + uid, not env secrecy. The MicroVM image is built by
  AWS Lambda (`update-microvm-image`, via `scripts/build-microvm-image.sh`) from `docker/Dockerfile.microvm` (base = its
  `FROM node:24-bookworm-slim`) — no local docker / buildx / ECR.

### MicroVM execution model

chat-worker lazily opens a MicroVM on the first tool use: `_ensureSandbox()` calls
`env.BROKER.openSession({ sessionId, ns, adminUrl, nsToken })`, which runs a fresh VM,
polls it to RUNNING, mints a short-lived JWE, pushes the session info to the agent's
`/init`, and returns `{ microvmId, endpoint, authToken, authTokenExpiresAt }` (stored in
session_meta). chat-worker then talks to the MicroVM's **public HTTPS endpoint** directly
(`https://<endpoint>/{run,write-file,read-file,list-files,package,export}` with the
`X-aws-proxy-auth` JWE), refreshing the JWE via `mintToken` near expiry. `requestClose`
calls `closeSession` (terminate, idempotent). There is no pool, no lease, no mesh, no
self-registration — each session gets its own ephemeral VM and its `/workspace` dies with
it.

`scripts/bootstrap.js` is a one-shot that ensures the `chat-db` schema (migrations, via your
`demo`-ns token store) and stores the delegated `token-issuer` credential from your operator
as the `TOKEN_ISSUER_TOKEN` secret (chat-worker uses it to mint per-session ns tokens); the
operator variant `--mint-issuer` mints one instead (needs an ops token). Unit tests live beside each worker (`workers/*/test/`, `sandbox-agent/test/`); `tests/e2e/`
is a thin live-stack harness driven by `WDL_CHAT_BASE_URL` + `WDL_CHAT_PASSCODE`.

## Tooling

- `npm test` — runs `workers/*/test/*.test.js` + `sandbox-agent/test/*.test.js` (offline,
  mocked). e2e tests are separate and need a live stack: `npm run test:e2e`.
- Deploy: `npm run deploy:sandbox-broker` / `deploy:chat` / `deploy:frontend` (each
  `wdl deploy . --ns demo` via the wdl-cli token store), or `bash scripts/deploy-workers.sh`
  for chat + frontend in order (regenerates `agents-md.gen.js`, then re-pins the frontend).
- Worker deploys use the **open-source `wdl-cli`** (`@wdl-dev/cli`, github.com/wdl-dev/cli);
  it implements `[durable_objects]` and `[[workflows]]`. The global `wdl` on PATH works for
  d1 / secret / migrations / workers / delete / workflows.
- **MicroVM image is built by Lambda, not here.** Edit `docker/Dockerfile.microvm` or
  `sandbox-agent/`, then rebuild with **`bash scripts/build-microvm-image.sh`** (zips
  `{ Dockerfile, sandbox-agent/ }` → S3 → `update-microvm-image` → polls; the CLI is npm-installed
  inside the image, pinned in `docker/Dockerfile.microvm`; `MIN_MEM_MIB=` to override). It's `update-microvm-image`, not
  `create-` (create rejects an existing name); a FAILED build leaves the prior version
  active. The script header documents the burst/peak memory model and the "Max allocated
  memory" 402 quota recovery (`terminate-microvm` the SUSPENDED orphans). Updating the
  AI's in-sandbox `AGENTS.md` does NOT need an image rebuild — it's injected at runtime
  (see below), so it ships with `wdl deploy chat-worker`.
- Bootstrap: a tenant holds two operator-issued credentials — a normal per-ns token for
  `demo` (the deploy credential in the wdl token store) and a delegated `token-issuer`. Default:
  `TOKEN_ISSUER_TOKEN=<delegated issuer> npm run bootstrap` (D1/secret go through the token
  store; no ops token). Operator variant: `--mint-issuer` with `ADMIN_URL` + `BOOTSTRAP_TOKEN`
  mints a fresh issuer (revoke any it replaces).
- **Deploy order: chat-worker before frontend.** The frontend's `env.CHAT` service binding
  is version-pinned at the frontend's deploy time, so a chat-worker change isn't visible on
  the user-facing path until the frontend is redeployed too. Same for the `BROKER` binding:
  chat-worker re-pins to the active sandbox-broker version at chat-worker deploy time.

## D1 Layout (`chat-db`)

```
sessions_index                                      cross-DO catalog
  id           TEXT PK                              session UUID
  ns           TEXT                                 the session's tmp ns (minted at start)
  ns_token_id  TEXT                                 auth token id of the delegated ns token
  status       TEXT                                 active | closed
  created_at, last_active_at INTEGER
```

ChatSessionDO-local SQLite (per session, in `ctx.storage.sql`):
```
session_meta(key TEXT PK, value TEXT)               sessionId / ns / nsToken / previewUrl / microvm*
messages(seq INTEGER PK, role, content, created_at) Anthropic-shape: content is JSON array
runs(run_id TEXT PK, status, cancel_requested, cancel_reason, started_at, ended_at, error, stop_reason)
steps(run_id, step_no, kind, input, output, status, started_at, ended_at)
```

## Secrets (`--ns demo`)

- chat-worker: `TOKEN_ISSUER_TOKEN` (narrow token-issuer credential — mints per-session ns
  tokens), `OPERATOR_TOKEN` (operator `/admin/*` endpoints), `LLM_API_KEY` (the
  DeepSeek key), `ADMIN_URL` (`https://api.wdl.dev`), `DEMO_PASSCODE`
  (portal gate).
- sandbox-broker: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (the broker's IAM user),
  `MICROVM_IMAGE_ARN` (the MicroVM image ARN — a secret so the account id isn't committed).
  Secrets are per ns+worker and write-only — renaming the worker requires re-putting them.

## Key Design Decisions

- **Per-session Lambda MicroVMs, not a pool.** Each session gets its own Firecracker
  MicroVM (Tokyo / ap-northeast-1), opened lazily on first tool use and terminated on
  Close. Reached over public HTTPS + a short-lived JWE; zero VPC. The broker is the sole
  AWS-key holder and exposes only open/mint/close — chat-worker never sees the AWS key.
- **Real-time session start, not a preallocated pool.** Users land on `#portal`, enter the
  passcode (`DEMO_PASSCODE`), and `POST /portal/start`, which mints a fresh `tmp-<hex>` ns
  + ns token from auth `/auth/delegated-tokens` (template `wdl-chat-ns-pool`: kind ns,
  ~6h TTL, server-side active quota), writes an `active` `sessions_index` row, and inits
  the DO on the current chat-worker version. `Close` marks `closed`; the short-lived ns
  token self-expires (chat-worker holds only the narrow `token-issuer` credential and
  cannot revoke). Closed sessions are **not reaped** (known limitation): the `sessions_index`
  row + per-session DO SQLite persist until a retention policy is added.
- **Agent loop runs as a WDL Workflow.** `addUserMessage` starts a `ChatRunWorkflow`
  instance; the workflow drives the loop as `step.do` bodies on the DO. The platform's
  Workflows engine has at-least-once semantics — it can re-dispatch a step (forward-timeout
  while the original runs, or DO eviction). Two idempotency layers cover this: (1) the
  **transcript is the commit record** — a re-dispatch that lands after the assistant reply /
  tool_results were already recorded replays the derived outcome instead of re-running
  (`replayLlmTurnOutcome` / `replayPlanOutcome` / `toolBatchAlreadyRan`); the tool batch is
  also **per-tool resumable**, keyed by the `tool_use` id journaled on each step
  (`_completedToolResults`), so a mid-batch re-dispatch doesn't re-run a completed tool's side
  effects. (2) **in-flight coalescing** (`_llmTurnInFlight` / `_toolBatchInFlight` / …) only
  dedups temporally-overlapping dispatches — it can't cover a sequential re-dispatch, which
  is why layer (1) exists. Plan-revise idempotency is **attempt-scoped**
  (`reviseAttemptDone:<runId>`), not text-keyed — the same note on two attempts must both run.
- **Plan mode.** A `plan_confirmed` message drafts a plan (reasoning model; shown as a card,
  not a chat bubble) and waits for the user's decision on a **per-attempt** event
  (`plan_approval-<attempt>`), so a buffered/duplicate decision can't apply to a later revised
  draft; then it executes. An empty plan (max_tokens spent on thinking) fails fast; Stop
  during the wait aborts via `_wakePlanWait` + a post-wait cancel-check.
- **`tool_result` content is capped at 256 KB** (head+tail, `capText`) so a large
  `run_command` / `read_file` output can't overflow the model context or poison later turns.
- **`run_command` timeoutSec is capped at 45s** (`RUN_COMMAND_TIMEOUT_CAP_SEC`). sandbox-agent
  kills the child at the cap so a hung command returns cleanly instead of the inbound
  MicroVM request hanging. AI-supplied values above 45 silently clamp.
- **`call_preview` captures worker logs alongside the response by default.** A tail SSE
  opens before the request, a grace period lets the Redis cursor settle, the request fires,
  then a drain window collects `worker_console` / exception events. Returns
  `{status, body, logs[], logs_error?}`. `capture_logs:false` skips it (~1s faster). Reason:
  `tail_logs` is forward-only (Redis Stream `$` cursor) — calling it after an error gets
  nothing; baking the tail into call_preview returns both the response and that exact
  request's logs.
- **`run_command` hard-blocks `npm install` / `npm i` / `npm ci` / `yarn install` /
  `yarn add`; `pnpm` is the only allowed install path.** npm chmods the root-owned
  `/opt/wdl-cli` bin so the sandbox uid hits EPERM; pnpm uses its own bin-shim model and
  skips that chmod. Allowing both also causes lock-file conflicts. `blockedCommandError`
  returns `{error, hint}` before any request reaches the VM.
- **`run_command` blocks bypass-deploy paths.** `blockedCommandError` rejects direct
  `wdl deploy|pack|tail` and `(pnpm|npm|yarn) [run] deploy[:variant]` (the npm-script
  wrappers `wdl init` scaffolds); `checkWranglerDeploy` rejects `wrangler deploy` unless
  it is a single `--dry-run` invocation (wrangler ships to wherever it is logged in, not
  our control plane). Plus `stripDeployScripts` deletes `deploy` / `deploy:*` from
  package.json after every `wdl init`. Detection is a shell-aware parser
  (`splitTopLevelOps` + `tokenizeShellArgs` + `commandArgvs`) that scans every argv
  position and descends into `bash -c` bodies and `$(...)` / backtick substitutions —
  not ad-hoc regex. It is robust but a guard, not a security boundary (that is the VM + uid).
- **sandbox-agent command lock is bounded.** `makeKeyedRwLock(acquireTimeoutMs)` returns 503
  ("sandbox busy") if a caller waits too long for the lock, so one slow `/run` can't
  strand every queued op. Read-only `/read-file` / `/list-files` take the read side — they
  run concurrently with each other but still wait behind an in-flight write.
- **One worker name per session: `app`.** Deploy hardcodes `FIXED_WORKER_NAME = "app"`;
  preview URL is always `https://<ns>.wdl.sh/app/`. Gives tenants a predictable ns surface
  and lets `call_preview` / `wdl tail` work without name plumbing.
- **LLM is DeepSeek V4 over the Anthropic-compatible API**, not Anthropic direct. Base URL
  `https://api.deepseek.com/anthropic`, header `x-api-key`. No prompt caching, supports
  `thinking` blocks. `LLM_API_KEY` holds the DeepSeek key (Anthropic-compatible API).
- **Per-call model selection (Pro + Flash mixed).** `pickModel` picks `LLM_MODEL` (default
  `deepseek-v4-pro`) when the last message is intent-bearing user text, and `LLM_MODEL_LITE`
  (default `deepseek-v4-flash`) for tool_result-only continuations. Both env-overridable.
- **LLM responses stream to the UI.** `callLlmMessages` accepts an `onDelta` callback that
  flips `stream:true` and consumes the Anthropic SSE format; do.js wires it to a
  `message.assistant_streaming` broadcast. Final response shape is identical to the
  non-streaming path. The SSE consumer normalizes CRLF on the whole buffer (chunk
  boundaries can split `\r\n`).
- **180s LLM budget + 16k max_tokens, both env-tunable.** `LLM_BUDGET_MS` bounds the
  AbortController + `setTimeout` around the DeepSeek fetch (set well under the Workflows
  step forward-timeout in production secrets). `LLM_MAX_TOKENS` caps output. The same abort
  controller is what `addUserMessage` (supersede) / `cancelLatestRun` (Stop) /
  `requestClose` (Close) abort, each with a distinct `signal.reason` that flows into
  `runs.cancel_reason` and the `run.aborted|failed|done` broadcasts.
- **Anthropic-spec strict messages, layered defense.** Every assistant `tool_use` must be
  paired with a `tool_result` in the next user turn (same id, in order). `_buildLlmMessages`
  is a read-side heal that scans assistant tool_use against the next user message's
  tool_result ids and synthesizes missing ones in-memory before the LLM call (storage stays
  as-is). This survives a Workflow step re-dispatch that committed an assistant message but
  not the following tool_results. Skipping it yields a 400 from DeepSeek.
- **DO NOT strip `thinking` blocks from history sent to DeepSeek V4 Pro.** DS V4 Pro returns
  `400 "The content[].thinking in the thinking mode must be passed back to the API."` when
  prior assistant turns are sent without their thinking blocks. `_buildLlmMessages` keeps
  thinking intact.
- **Parallel read-only tool dispatch.** Contiguous read-only tool_uses (`read_file` /
  `list_files` / `tail_logs`, in `READ_ONLY_TOOLS`) run in a Promise.all batch with one
  shared AbortController. Effectful tools (`write_file` / `run_command` / `deploy_test` /
  `call_preview`) stay serial because of the sandbox mutex and ordering.
- **ASSETS-first guidance is a hard rule in the system prompt (promptPack) + AGENTS.md.** Without it the
  model inlines whole HTML strings in `return new Response('<html>...')`, blowing
  max_tokens and bloating the bundle. Rule: HTML/CSS/JS into `/workspace/public/`, wrangler
  `assets: {directory: "./public"}`, `env.ASSETS.url()` for CDN URLs; only dynamic API
  parts stay in worker code.
- **Plan-confirm mode.** Gated behind `#plan=1` (no UI toggle): the workflow drafts a plan,
  waits for user approval (`step.waitForEvent`, with revise/reject), then executes it to
  completion.
- **deploy_test runs entirely in chat-worker.** tools.js POSTs `/package` to the MicroVM to
  pack the bundle, then calls control `/ns/<ns>/worker/app/deploy` + `/promote` directly
  with `x-admin-token: ctx.nsToken`. The MicroVM only packs; chat-worker owns the control
  calls. previewUrl = `https://<ns>.wdl.sh/app/`. The packaged stderr surfaces in the
  tool's `upstream` field so the AI sees the real wrangler error.
- **sandbox-agent runs as root, AI subprocesses run as `sandbox` uid (2000).** The
  supervisor is root (so `gosu` needs no setuid); AI subprocesses spawn via `gosu sandbox`
  and Linux `/proc/<pid>/environ` 0400 owner-only is the env-isolation boundary — the
  sandbox uid cannot read root's environ (which carries the injected ns token).
  `/write-file` chowns written files (and any newly-created parent dirs up to /workspace) to
  the sandbox uid so later `gosu sandbox` builds don't EACCES.
- **Post-`wdl init` rewrites.** After a successful `wdl init`, `tools.js#runCommand` (1)
  overwrites `/workspace/AGENTS.md` with the bundled sandbox version — source of truth is
  `workers/chat/src/agents-md.md` + `agents-md.en.md`, regenerated into `agents-md.gen.js` + `agents-md.en.gen.js` by
  `scripts/build-agents-md.mjs`, POSTed via the MicroVM `/write-file` (so updating AGENTS.md
  is a `wdl deploy chat-worker`, no image rebuild); and (2) `stripDeployScripts` deletes
  `deploy` / `deploy:*` from package.json (the stock CLI scaffolds them) so the AI never
  sees them.
- **UI is bilingual i18n (EN default, zh toggle).** Brand "WDL·CHAT" stays uppercase; the en + zh
  `STRINGS` packs must stay in sync. `终止` / End (Close) permanently marks the session `closed`.
- **DO facets are pinned to the worker version they were constructed with.** Redeploying
  chat-worker does not patch in-flight sessions — they run the old code until the host actor
  restarts or the session closes. Mid-session fixes need operator force-close
  (`/admin/sessions/<id>/force-close`) or user Close.
- **Stream replay.** `GET /stream` (WebSocket or SSE) re-emits, on every (re)attach, the
  message history (frontend de-dups by `seq`), the current run's state (`run.scheduled`, mode
  derived from whether it's parked at plan), and the plan card if parked. It picks the
  **newest run by start time** (not the latest still-active one), so a superseded run that
  outlives a newer completed one doesn't replay a stale status. Tool activity is rendered from
  the assistant turn's `tool_use` blocks, not a separate step channel. `_endRun` sweeps any
  `running` steps to `aborted` on every terminal transition.

## Common Gotchas

- **`wdl pack <dir>` is a flat-directory packer**, not a project deployer — it looks for
  `worker.js` at the dir root and ignores wrangler config. `run_command` hard-blocks `wdl pack`
  (`BLOCKED_WDL_SUBCMDS`); do not relax that.
- **Stock open-source CLI, no sandbox fork** (`@wdl-dev/cli`, github.com/wdl-dev/cli). Its adaptations are handled wdl-chat-side:
  per-session `HOME` is a sibling of the project dir (so tooling dotfiles never land in the
  project), the **sandbox/agent session id == the tmp-<hex> ns** (so the project dir name is
  letter-leading and passes `wdl init`'s package-name check — this is the ns, distinct from
  the chat session id, which is the random bearer above), and the `deploy` script is removed by
  `stripDeployScripts`.
- **bootstrap.js stores a provided `TOKEN_ISSUER_TOKEN` by default; `--mint-issuer` mints a
  new one.** The DB step is idempotent. Each `--mint-issuer` run mints a fresh credential that
  stays live until you `auth.revoke` its tokenId. Per-session ns tokens self-expire on the template TTL.
- **Anthropic-compatible DeepSeek rejects mismatched message ordering aggressively** — a
  "tool_use without tool_result" error is fatal for the whole conversation. Every place that
  appends a user message must keep tool_use/tool_result pairing intact.
- **The LLM defaults to Cloudflare branding** unless told otherwise (wrangler + workerd =
  "Cloudflare Workers" in its prior). AGENTS.md has a "这不是 Cloudflare Workers" section; if
  generated output still leaks Cloudflare wording, strengthen AGENTS.md (the layer the AI
  reads while writing code), not the system prompt.
- **Frontend is a service binding, not a route.** chat-frontend's `services` maps
  `CHAT → chat-worker`; the frontend at `/` serves the SPA and `/api/*` proxies. Don't add a
  `routes` field to chat-worker.
- **Service binding version is frozen at the caller's deploy time.** Redeploy chat-worker →
  the frontend keeps its old `CHAT` pin until the frontend is redeployed; likewise
  chat-worker's `BROKER` pin to sandbox-broker. Symptom: "I deployed but the new behavior
  isn't visible from the browser."
- **chat.wdl.dev is a pattern host — the path is NOT stripped.** The SPA must use absolute
  `/api/...` URLs (the worker proxies `/api/*` to chat-worker); relative paths or a
  `/chat/api/...` prefix break.
- **The stream replays history on every attach** (server-side, over WebSocket or SSE;
  EventSource also auto-reconnects). The frontend de-dups by `seq` (`renderedMessageSeqs`);
  don't remove it or every reconnect double-renders.
- **The `Close` button is the universal escape hatch** — `requestClose` aborts the in-flight
  LLM and tears down the session (and terminates the MicroVM). When Stop appears stuck (DO on
  a pre-fix version), tell the user to Close.
- **Completed Workflow instances pin their worker version.** A worker version that ever ran a
  ChatRunWorkflow can't be deleted until its (even completed) instances are purged;
  `wdl workflows terminate` is a no-op on a completed instance. This blocks `wdl delete`
  cleanup of old chat-worker versions — but wdl-chat sets short retention (1h/24h) at create, so the
  pin clears within a day.

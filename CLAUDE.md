# CLAUDE.md

## Project Overview

wdl-chat is an AI-driven WDL Worker development platform built **on top of** the WDL
self-hosted Workers platform. Users describe a Worker in
chat; an LLM agent writes code in a per-session sandbox MicroVM, deploys it to a tmp
namespace via `deploy_test`, and shows a preview iframe. This project is just a tenant of
the platform — it deploys to the regular `demo` ns and uses the open-source CLI
(`@wdl-dev/cli`, github.com/wdl-dev/cli) like any other tenant. The platform repo
([wdl-dev/wdl](https://github.com/wdl-dev/wdl); its docs are the platform-mechanics
source of truth — re-read them rather than duplicating here; all org docs are also aggregated
at **wdl.md**, where appending `.md` to any page returns the markdown source) runs the control
plane at **api.wdl.dev**, serves tenant workers at **\*.wdl.sh**, and this app at
**chat.wdl.dev**. The public site is **wdl.dev**.

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
- **Every deploy path then prunes old versions — irreversibly.** `scripts/prune-versions.sh <worker>
  --ns <ns> [--keep N]` keeps the newest 3 (plus the active one) and deletes the rest, walking the
  binding chain `chat → chat-worker → sandbox-broker` because freeing a caller's versions is what
  makes the callee's deletable. It is best effort: a version another worker still pins answers
  `409 version_referenced` and is retried by the next deploy, and nothing it does — including a bad
  config — ever exits non-zero, so a tidy-up can't make CI retry a deploy that already succeeded.
  Override retention with `WDL_PRUNE_KEEP=N` (applies to every prune in the chain; `--keep` only
  reaches the single invocation it is attached to); to skip pruning entirely, run `wdl deploy`
  directly instead of the npm script. **Rollback targets beyond the newest 3 are gone**, so pin/copy
  a version first if you need to go further back.
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
  tokens), `OPERATOR_TOKEN` (operator `/admin/*` endpoints), `LLM_API_KEY` (the LLM provider
  key), `ADMIN_URL` (`https://api.wdl.dev`), `DEMO_PASSCODE` (portal gate); plus the optional
  `LLM_*` overrides (`LLM_API_SHAPE` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_MODEL_LITE` /
  `LLM_MAX_TOKENS` / `LLM_MAX_TOKENS_PARAM` / `LLM_BUDGET_MS` / `LLM_REASONING_EFFORT`) — these pin
  the live provider; see the LLM design decision for the current pick and its constraints
  (`LLM_MAX_TOKENS_PARAM=max_completion_tokens` is required for OpenAI reasoning models).
- sandbox-broker: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (the broker's IAM user),
  `MICROVM_IMAGE_ARN` (the MicroVM image ARN — a secret so the account id isn't committed).
  Secrets are per ns+worker and write-only — renaming the worker requires re-putting them.

## Key Design Decisions

- **Per-session Lambda MicroVMs, not a pool.** Each session gets its own Firecracker
  MicroVM (Tokyo / ap-northeast-1), opened lazily on first tool use and terminated on
  Close. Reached over public HTTPS + a short-lived JWE; zero VPC. The broker is the sole
  AWS-key holder and exposes only open/mint/close — chat-worker never sees the AWS key.
  VM lifetime is aligned to the 6h ns-token TTL (`MAX_LIFETIME_SECONDS`; idle-suspend
  after 10min saves compute, but a suspended VM is never idle-terminated before the 6h
  cap), so the only session death is the 6h clock — never a VM reclaimed out from under
  a valid token. Suspended VMs still count against the Lambda "Max allocated memory"
  quota, so abandoned sessions hold their memory for the full 6h.
- **Real-time session start, not a preallocated pool.** Users land on `#portal`, enter the
  passcode (`DEMO_PASSCODE`), and `POST /portal/start`, which mints a fresh `tmp-<hex>` ns
  + ns token from auth `/auth/delegated-tokens` (template `wdl-chat-ns-pool`: kind ns,
  ~6h TTL, server-side active quota), writes an `active` `sessions_index` row, and inits
  the DO on the current chat-worker version. `Close` marks `closed`; the short-lived ns
  token self-expires (chat-worker holds only the narrow `token-issuer` credential and
  cannot revoke). Closed sessions are **not reaped** (known limitation): the `sessions_index`
  row + per-session DO SQLite persist until a retention policy is added.
- **6h hard session lifetime, lazily enforced.** Sessions die at `created_at + 6h - 5min`
  (`DELEGATED_TTL_MS` mirrors the `wdl-chat-ns-pool` template TTL — operator changes to the
  template must update the constant). There is no reaper: the router's shared gates enforce
  it on the next request that reaches them — `requireActiveSession` (messages/cancel/approve-plan/upload)
  answers **410 "session expired"**, `proxyGetToDo` (stream/export) answers 404. Body
  parsing/validation runs first, so a malformed write (empty/oversized/bad-JSON → 400/413)
  rejects *before* the gate and does not expire; a session that only ever gets invalid
  traffic falls back to the broker's 6h max VM lifetime. `expireSession`
  tears down via DO `expire()` (= `_closeSession("expired")`: abort run, terminate VM,
  broadcast `session.closed {reason:"expired"}`), falling back to `requestClose()` for DO
  facets pinned to a pre-`expire()` version, then fences `sessions_index` to `closed`.
  A run in flight when the deadline passes is aborted at the next workflow step boundary
  (`_isCancelled` folds in `_cancelIfExpired` → cancel reason `"expired"`) — that path only
  stops the run; VM/catalog teardown still waits for the next router access (or the broker's
  6h max lifetime).
  `/portal/start` returns `expiresAt` (the gate time); the SPA shows it as a live countdown
  (`#countdown`), disables the composer at 0 client-side, treats any 410 as expiry, and
  explains the expiry on the portal when a dead session is reopened cold. Deliberately no
  recovery: no VM reopen, no workspace rebuild from history — the transcript stays readable
  on screen, `Export` must happen before the deadline.
- **Agent loop runs as a WDL Workflow.** `addUserMessage` starts a `ChatRunWorkflow`
  instance; the workflow drives the loop as `step.do` bodies on the DO. The platform's
  Workflows engine has at-least-once semantics — it can re-dispatch a step (forward-timeout
  while the original runs, or DO eviction). Two idempotency layers cover this: (1) the
  **transcript is the commit record** — a re-dispatch that lands after the assistant reply /
  tool_results were already recorded replays the derived outcome instead of re-running
  (`replayLlmTurnOutcome` / `replayPlanOutcome` / `toolBatchAlreadyRan`); the tool batch is
  also **per-tool resumable**, keyed by the `tool_use` id **plus the assistant turn's `seq`**
  journaled on each step (`_completedToolResults` / `sameBatch`), so a mid-batch re-dispatch doesn't
  re-run a completed tool's side effects — while a provider that reuses ids like `call_0` across turns
  can't make a later batch inherit an earlier result. Matching is strict equality, so a step journaled before
  `batchSeq` existed matches nothing and its tool re-runs. That is reachable only for a run in flight
  across the one deploy that introduced the field — every step journaled since carries it — so the
  window is closed rather than defended in code. (2) **in-flight coalescing** (`_llmTurnInFlight` / `_toolBatchInFlight` / …) only
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
- **`run_command` blocks bypass-deploy paths — a best-effort UX steer, deliberately not airtight.**
  `blockedCommandError` rejects direct `wdl deploy|pack|tail` and `(pnpm|npm|yarn) [run]
  deploy[:variant]` (the npm-script wrappers `wdl init` scaffolds); `checkWranglerDeploy` rejects
  `wrangler deploy` unless it is a single `--dry-run` invocation. Plus `stripDeployScripts` deletes
  `deploy` / `deploy:*` from package.json after every `wdl init`. Detection is a shell-aware parser
  (`splitTopLevelOps` + `tokenizeShellArgs` + `commandArgvs`) that peels a leading `sudo` / `VAR=`
  assignment and package-runner wrappers (`npx` / `pnpm|yarn exec|dlx` / `bunx`), descends into
  `bash -c` bodies and `$(...)` / backtick substitutions, and checks argv[0]/subcommand — not ad-hoc
  regex. **It only catches the obvious forms an LLM actually emits.** It intentionally does NOT chase
  exotic variants — other launcher wrappers (`env`/`nice`/`setsid` prefixes), per-flag arity, npm
  aliases (`in`, `it`, `run-script`), package-manager global flags before the subcommand, or `-c`
  command bodies. Those slip through, and that is fine: **this is not a security boundary (the VM +
  uid is), and its only real job is steering the model off `npm install` (which chmod-breaks
  `/opt/wdl-cli`) and off the wrong deploy path — a slipped command still can't escape the VM.** Do
  not re-grow per-flag arity tables / alias normalization to close corner cases; that was tried and
  reverted (net-negative — the pile-up still had corner cases and read as complete when it wasn't).
- **sandbox-agent command lock is bounded.** `makeKeyedRwLock(acquireTimeoutMs)` returns 503
  ("sandbox busy") if a caller waits too long for the lock, so one slow `/run` can't
  strand every queued op. Read-only `/read-file` / `/list-files` take the read side — they
  run concurrently with each other but still wait behind an in-flight write.
- **One worker name per session: `app`.** Deploy hardcodes `FIXED_WORKER_NAME = "app"`;
  preview URL is always `https://<ns>.wdl.sh/app/`. Gives tenants a predictable ns surface
  and lets `call_preview` / `wdl tail` work without name plumbing.
- **Supported models: DeepSeek V4, Qwen 3.7, Grok 4.5 — nothing else.** Code defaults to
  `deepseek-v4-pro` / `deepseek-v4-flash` on the Anthropic shape; the live provider is whatever the
  `LLM_*` secrets say — the secrets are the source of truth, this file only records the rationale.
  As of 2026-08-01 that is `deepseek-v4-flash` (the GA rebuild) over its OpenAI endpoint
  (`LLM_API_SHAPE=openai`, `LLM_BASE_URL=https://api.deepseek.com`) with **`LLM_REASONING_EFFORT=low`,
  which is mandatory there** — unset, the model spends the whole 90s budget thinking and every open-ended
  run dies. `grok-4.5` (xAI direct, effort=low; 4/4 on `npm run bench`) and `qwen3.7-max` (Aliyun
  gateway, Anthropic shape) are the vetted alternates.
  Others were measured and dropped — Kimi K3 (~3× slower), GLM-5.2 (spends the whole budget
  thinking), Doubao Seed 2.1 (a single call ran 302s) — see the LLM-provider memory for the numbers
  before re-testing any of them. The Anthropic shape sends `x-api-key` only (a stray `Authorization`
  401s some endpoints); the OpenAI shape sends `Authorization: Bearer` only. Never add
  temperature/top_p.
- **Both wire shapes are supported; Anthropic is canonical.** The DO pipeline (storage, replay,
  `_buildLlmMessages`, the UI stream) speaks Anthropic content blocks everywhere;
  `LLM_API_SHAPE=openai` (missing / empty / exactly `anthropic` → Anthropic; any other non-empty value
  throws — a typo must not silently ship the key to the wrong provider) makes `llm.js` convert at
  the provider boundary via `llm-openai.js` — request (`system` role message, `tool_result` →
  `role:"tool"`, thinking → `reasoning_content`, tools → function wrappers), response, and SSE
  (`data:`-only frames, `[DONE]` ends consumption without waiting for HTTP EOF, incremental
  `tool_calls` argument JSON) all map back to the same
  Anthropic result shape, so callers can't tell which wire was used. Default base URL flips with
  the shape (`https://api.deepseek.com`); auth is Bearer-only on the OpenAI shape. The token-cap
  field is provider-specific (`LLM_MAX_TOKENS_PARAM`, default `max_tokens`): DeepSeek **silently
  ignores** `max_completion_tokens` and honors only `max_tokens`, while OpenAI reasoning models
  reject `max_tokens` — so the default is `max_tokens` (correct for all three supported models).
  Streaming asks for `stream_options:{include_usage:true}` so spec-standard OpenAI still returns a
  usage frame, and both consumers stop at their terminator (`[DONE]` / `message_stop`) rather than
  waiting for HTTP EOF — otherwise a provider that holds the connection open burns the whole
  `LLM_BUDGET_MS`. A stream that ends without one throws instead of recording a partial turn as
  finished. `LLM_REASONING_EFFORT` maps to `reasoning_effort` (OpenAI shape) but nested
  `output_config.effort` (Anthropic shape — the top-level field is OpenAI-only). `tool_result.is_error`
  has no OpenAI equivalent and is dropped: tool error payloads are self-describing JSON. stop_reason
  mapping: `stop→end_turn`, `tool_calls→tool_use`, `length→max_tokens`, unknown values pass through.
  Thinking is replayed verbatim on both wires, signed or not — see the signature bullet below for why
  filtering is not an option here. Verified live against DeepSeek V4, Qwen 3.7 and Grok 4.5 on both
  shapes, plus OpenAI gpt-5.4 before it was region-blocked.
- **`finalizeResponse` is the one gate every response passes** (`llm-sse.js`), whichever of the four
  paths produced it. It checks only what the DO state machine depends on — a stop_reason, an id on
  each tool_use (tool_results are matched by id), and something displayable. It deliberately does not
  cross-check tool_use against `stop_reason`: a token cap landing right after a tool_use block closes
  yields `max_tokens` with a complete call, which is legitimate and which the run loop handles. It is
  **not** a protocol-conformance check: malformed provider output fails the run on its own, and an
  earlier attempt to validate every way a provider could violate its spec never converged (each new
  rule interacted with the last and introduced its own holes) while never once firing against a real
  provider. Keep new checks to invariants the DO genuinely needs.
- **Per-call model selection.** `pickModel` picks `LLM_MODEL` when the last message is
  intent-bearing user text, and `LLM_MODEL_LITE` for tool_result-only continuations. Code
  defaults are `deepseek-v4-pro` / `-flash`; either tier is a secret change, no code.
- **LLM responses stream to the UI.** `callLlmMessages` accepts an `onDelta` callback that
  flips `stream:true` and consumes the Anthropic SSE format; do.js wires it to a
  `message.assistant_streaming` broadcast. Final response shape is identical to the
  non-streaming path. The SSE consumer normalizes CRLF on the whole buffer (chunk
  boundaries can split `\r\n`).
- **A cut-short turn is salvaged, not discarded.** The LLM budget is our own deadline, so when it
  fires (`signal.reason === "llm_timeout"`) the stream consumers hand back what already arrived —
  text/thinking plus every tool call whose arguments actually closed; a half-streamed call — including
  one with zero argument bytes yet — is dropped rather than dispatched with junk. If a call survives,
  `stop_reason` becomes `tool_use` and the run continues; if only text survives it becomes
  `max_tokens` and the run ends done with the partial answer visible (same as a provider cap). A user
  Stop/Close carries a different reason and still discards, which is what they asked for.
  `_runLlmStep` then clears the deadline's own `cancel_reason = 'llm_timeout'` (scoped — a user Stop
  writes its own reason, so it never matches and always wins).
- **The run loop branches on content, not `stop_reason`.** A turn truncated by the token cap still
  carries finished tool calls; ending the run there reported a half-done job as success (observed on
  DeepSeek@2500 and glm-5.2@3000 — both silently stopped before ever deploying). The loop now stops
  only when the model has no tool call left to run. A turn with neither a tool call nor text — the
  whole budget spent thinking, which glm-5.2 does reliably — ends the run **failed** with a visible
  message rather than a green "done" over a blank reply.
- **Providers split into "max_tokens bounds reasoning" and "it doesn't", and that is a property of the
  (gateway, model) pair, not the model.** Measured 2026-07-31 with `max_tokens=200`: DeepSeek v4
  pro/flash return exactly 201 on all three gateways (official / Aliyun / Volcano) — a real ceiling on
  turn duration. `glm-5.2` bounds on Aliyun (201) but **not** on Volcano (`glm-5-2-260617` → 2152).
  Qwen 3.7 overshoots ~12x, Grok ignores the cap entirely, Doubao Seed 2.1 pro returned 10888 tokens in
  302s. Never infer this from a model name — measure the pair. On unbounded models `LLM_MAX_TOKENS` is
  not a duration knob and only salvage keeps them usable.
- **`LLM_MAX_TOKENS_PARAM` has exactly two valid values** (`max_tokens`, `max_completion_tokens`)
  **and `resolveLlmConfig` throws on anything else.** Chat Completions *accepts and silently ignores*
  unknown cap fields (measured with `max_output_tokens`, the Responses-API name), so the provider
  would never surface the typo and the cap would go unenforced with nothing to diagnose. Same trap as
  xAI's Anthropic endpoint accepting `thinking.budget_tokens` and ignoring it.
- **180s LLM budget + 16k max_tokens, both env-tunable.** `LLM_BUDGET_MS` bounds the
  AbortController + `setTimeout` around the LLM fetch (set well under the Workflows
  step forward-timeout in production secrets). `LLM_MAX_TOKENS` caps output. The same abort
  controller is what `addUserMessage` (supersede) / `cancelLatestRun` (Stop) /
  `requestClose` (Close) abort, each with a distinct `signal.reason` that flows into
  `runs.cancel_reason` and the `run.aborted|failed|done` broadcasts.
- **Anthropic-spec strict messages, layered defense.** Every assistant `tool_use` must be
  paired with a `tool_result` in the next user turn (same id, in order). `_buildLlmMessages`
  is a read-side heal that scans assistant tool_use against the next user message's
  tool_result ids and synthesizes missing ones in-memory before the LLM call (storage stays
  as-is). This survives a Workflow step re-dispatch that committed an assistant message but
  not the following tool_results. Skipping it yields a 400 from the provider.
- **DO NOT strip `thinking` blocks from history sent to the LLM.** Providers require the prior turns'
  reasoning replayed as-is; DeepSeek V4 Pro answers a hard 400 without it, others degrade multi-step
  continuity silently — the worse failure, because nothing surfaces the mistake. `_buildLlmMessages`
  keeps thinking intact.
- **None of our providers sign thinking blocks** (measured 2026-07-31 on the Anthropic wire:
  DeepSeek, Qwen and Grok all return `signature: ""` and never send a `signature_delta`). So
  signature-based handling is not an option here: filtering unsigned thinking out of replayed history
  would strip every thinking block we ever get — the exact silent degradation the rule above forbids —
  and rejecting unsigned thinking before running tools would fail every tool turn. Anthropic proper
  does sign; gate either idea on the provider if that endpoint is ever used directly.
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
- **Anthropic-compatible providers reject mismatched message ordering aggressively** (observed
  on DeepSeek; assume the same of the others) — a "tool_use without tool_result" error is fatal
  for the whole conversation. Every place that appends a user message must keep
  tool_use/tool_result pairing intact.
- **A provider that works from your laptop can be geo-blocked from production.** chat-worker's
  egress is the platform's ap-east-1 (Hong Kong) — OpenAI answers 403
  `unsupported_country_region_territory` and the direct Gemini API 400
  `User location is not supported` from there — and OpenRouter enforces the same block per model, so
  routing around it does not help. DeepSeek, Qwen (Aliyun) and xAI all work. Verify a
  candidate provider from the real egress before flipping secrets: deploy a throwaway worker in
  the demo ns that forwards a request (key passed via request header, never stored) and delete
  it after. Local curl success proves nothing about production.
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

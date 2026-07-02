# Contributing

Thanks for helping improve wdl-chat. This file is the contributor entrypoint;
`CLAUDE.md` carries the full architecture, invariants, security boundaries, and
gotchas — read it before changing anything non-trivial.

## Development setup

Requires Node.js 24 or newer.

```bash
git clone https://github.com/wdl-dev/chat.git
cd chat
npm install            # installs the workspaces (workers/*, sandbox-agent)
npm test               # unit suite — runs fully offline
```

The unit suite needs no platform, no AWS, and no network: every test injects a
fake `fetch` / dependencies, so parsing, the run state machine, the tool guards,
prompt assembly, and message healing are all exercisable offline. To run a real
session end to end you need a WDL control plane, the `BROKER` AWS credentials,
and the chat-worker secrets (see Deploy); the e2e suite (`npm run test:e2e`)
drives the live deployment and reads `WDL_CHAT_BASE_URL` (required) and `WDL_CHAT_PASSCODE`.

## Architecture

wdl-chat is a tenant product on the WDL platform, split across four tiers:

| Path                      | Role                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers/chat/`           | chat-worker — `ChatSessionDO` (transcript, SSE/WS broadcast, run state) + `ChatRunWorkflow` (the agent loop) + `tools.js` / `llm.js` / `agent-prompt.js`. |
| `workers/frontend/`       | the SPA shell + `/api` proxy (worker name `chat`); serves chat.wdl.dev.                                                                              |
| `workers/sandbox-broker/` | stateless JSRPC broker for the Lambda MicroVM lifecycle — the **only** holder of the AWS key.                                                        |
| `sandbox-agent/`          | the HTTP file/exec server that runs as root inside each per-session MicroVM (baked into the image).                                                  |

Invariants worth keeping (the full list is in `CLAUDE.md`):

- **The sandbox boundary is the MicroVM + uid, not env secrecy.** Untrusted
  AI-directed code runs as a non-root uid inside a per-session Firecracker VM.
- **One session == one MicroVM**, opened lazily and reclaimed aggressively; no
  standing pool, no leases.
- **Workflows are at-least-once** — any step that calls the LLM or inserts a
  message is single-flighted (`_coalesce`), or a re-dispatch double-runs it.
- **Service bindings pin at deploy time.** A broker change needs the full
  re-pin chain: deploy broker → redeploy chat-worker → redeploy frontend.
- **Secrets stay server-side**; never log them, never render them to the tenant.

## Where to start

- Bug reports with a failing reproduction are the most valuable input.
- The sandbox's AI guidance (`workers/chat/src/agents-md.{md,en.md}` and the
  system prompt in `agent-prompt.js`) must match the real platform/CLI behavior
  — drift there makes the agent generate wrong code (file or fix it).
- Generated-worker correctness: the agent's first-gen output should deploy
  clean; a pattern that needs debug-and-retry is usually a prompt/AGENTS.md bug.

## Checks

CI runs two gates on every pull request — a dependency-free syntax check over
all tracked JS/MJS, then the unit suite:

```bash
npm run check   # node --check on every *.js / *.mjs
npm test
```

There is no separate lint/typecheck step; keep changes consistent with the
surrounding code (ES2025, Node 24).

## Tests

Tests use `node:test` and `node:assert/strict` — no external framework. Mock
`fetch` and dependencies instead of touching the network; keep new unit tests
with their topic group under the matching `test/` directory. The e2e suite
(`tests/e2e/`) drives the live deployment and is not part of `npm test`.

## Documentation

`CLAUDE.md` is canonical for architecture and conventions. The sandbox
`AGENTS.md` is **generated** from `workers/chat/src/agents-md.md` (Chinese) and
`agents-md.en.md` (English) via `scripts/build-agents-md.mjs` — both languages
are authoritative; edit the pair and regenerate the `*.gen.js` in the same
change. In Chinese prose use full-width punctuation (`，。；：？！（）`).

## Commits and pull requests

Use short, imperative commit subjects (`Add upload size guard`). Pull requests
should describe the user-visible change and list the tests run.

## Deploying

wdl-chat is deployed, not published. Workers go out with
`bash scripts/deploy-workers.sh` (chat-worker then frontend, in that order, to
re-pin the service binding). The MicroVM sandbox image is rebuilt separately
with `bash scripts/build-microvm-image.sh` (see its header for the burst/quota
notes). Updating the in-sandbox `AGENTS.md` is a chat-worker deploy, not an
image rebuild.

## Security issues

Do not open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).

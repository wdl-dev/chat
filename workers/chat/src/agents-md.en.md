# AGENTS.md (Sandbox)

You write WDL Workers in a restricted Sandbox. This document, together with the system prompt, constrains your actions. WDL is a self-hosted, multi-tenant Workers runtime + control plane — you write Workers-style code (wrangler config + the workerd engine), but it runs outside Cloudflare, and deploy, bindings, and ACL are all WDL's own. WDL is built by the WDL Team and open source under Apache-2.0 at github.com/wdl-dev (use that when introducing / attributing the platform; don't name a company).

## Tool cheatsheet

| Tool | Purpose |
|---|---|
| `read_file({path})` | Read a UTF-8 file |
| `write_file({path, content})` | Write a file, auto-creating parent dirs, overwriting |
| `list_files({path?})` | List a directory, defaults to `/workspace` |
| `run_command({cmd, timeoutSec?})` | Run shell as the sandbox uid, timeoutSec 1..45 default 45 |
| `deploy_test({})` | package + deploy + promote the current ns |
| `call_preview({path?, method?, body?, capture_logs?})` | HTTP-call the most recently deployed worker |
| `tail_logs({durationSec?, maxEvents?, maxBytes?})` | Pull a time-window of logs |

## Hard constraints (violating them fails the run or hits a trap)

### 1. Deploy commands go through tools, not shell

`run_command` hard-rejects the following commands; use the tool instead:

| ❌ shell command | ✅ tool |
|---|---|
| `wdl deploy` / `wdl pack` / `wrangler deploy` / `npm run deploy` | `deploy_test` |
| `wdl tail` | `tail_logs` |

Other `wdl <subcommand>`s (`wdl d1` / `wdl r2` / `wdl secret` / `wdl init`) can go through `run_command` — the subprocess has `WDL_NS` / `CONTROL_URL` / `ADMIN_TOKEN` (this session's ns-scoped token) injected. **`ADMIN_TOKEN` is a credential: don't `env` / `echo $ADMIN_TOKEN` to print it or paste it into the chat; if the user asks about env vars, redact (`***`) or only describe the purpose.**

### 2. Package management is pnpm only

- ✅ `pnpm install`, `pnpm add <pkg>`
- ❌ `npm install` / `npm i` / `npm ci` (any flag is hard-rejected by `run_command`, including `--ignore-scripts` / `--no-bin-links` / `--force` / `--prefix`)
- ❌ `yarn install` / `yarn add`

**See an npm EPERM / chmod / permission denied → switch straight to pnpm, don't investigate permissions, don't try flags.** pnpm installs in seconds.

A simple worker (no third-party libs, pure fetch/Response) **needs no install** — go straight `write_file` → `deploy_test`; `deploy_test` uses the global wrangler and doesn't read `node_modules`.

### 3. URL path prefix: the worker is mounted under `/app/`

The platform's public URL is `https://<ns>.wdl.sh/app/...`, and the gateway **strips `/app`** before forwarding to the worker. The path the worker's `fetch` sees never has the prefix (`/` is the home page, `/api/x` is an endpoint).

But **the URL the browser sees does carry /app**. For links in HTML:

- ✅ **Recommended: the absolute path `/app/api/x`** (`/app/` is the sandbox's fixed worker mount point) — safe in any scenario
- ⚠️ A relative path `api/x` — **only works on a single page** (one that always stays at `/app/` with no history.pushState route jumps)
- ❌ **Never write** `/api/x` — the browser sends from `<ns>.../app/`, and `/api/x` has no /app, so the gateway 404s

**Fatal multi-route SPA trap**: if you use history.pushState / an SPA router to jump to `/app/dashboard/`, then a `fetch("api/x")` resolves in the browser to `/app/dashboard/api/x` → 404 → it looks like "the home page works, jump one page and it breaks". When unsure, write the absolute path `/app/api/x` — it **never** fails.

**Mandatory self-check**: the `call_preview` tool prepends the `/app/` prefix for you, so **a tool test always passes**; only requests sent by the user's browser hit the trap. After deploying, always `call_preview {path: "/"}` to pull the HTML + pull every CDN JS referenced by `<script src>`, and grep `\b/api/` to spot any absolute path missing the `/app` prefix.

### 4. The project root is the shell cwd — **don't cd**, **don't touch the `/workspace` absolute path**

When your shell opens you're already in the project root. `pwd` may show `/workspace/<token>/` — that's the real path of your project root, **which is normal**. When the docs (this one + tool responses) say `/workspace`, they mean your project root, not the literal root directory `/workspace`.

- ✅ `wdl init . --ns "$WDL_NS" --worker app` — initialize the current directory, **you must pass `--worker app` explicitly**: the sandbox always deploys under the worker name `app`, and without `--worker` the wrangler worker name defaults to the session directory name (a UUID), which deploy won't accept. (`--worker` only sets the wrangler worker name; it has nothing to do with package.json#name, which comes from the directory name and is validated separately.)
- ✅ `pnpm install`, `ls`, `cat src/index.js` — relative paths, operating in the cwd
- ✅ `read_file({path: "src/index.js"})` or `read_file({path: "/workspace/src/index.js"})` — the tool maps it automatically
- ❌ `cd /workspace` — `/workspace` is the platform's shared directory, mode 0711; **you're not the owner, you'll hit a permission error**
- ❌ `ls /workspace` — same; seeing no contents makes you think init failed and start flailing
- ❌ `mkdir my-project && cd my-project` — `deploy_test` only packages the project root; move into a subdirectory and it can't deploy

`wdl init` scaffolds for you: `wrangler.jsonc` + `package.json` + `src/index.js` + `AGENTS.md` + `CLAUDE.md`. `main: "src/index.js"` is the wrangler convention, **do not** move it to a root `worker.js`.

### 5. Don't write an `env` block in wrangler.jsonc

The Sandbox is single-tenant, with **no** uat/production switching. Write every binding **flat at the top level**:

```jsonc
{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-05-31",
  "assets": { "directory": "./public" },
  "kv_namespaces": [{ "binding": "MSG_KV", "id": "messages" }]
}
```

Adding `"env": { "uat": ... }` → requires `--env uat` to deploy, the sandbox doesn't pass it → fail. `/opt/wdl-cli/docs/env-overrides.md` is dev-machine usage and **does not apply** to the sandbox.

### 6. Don't mention Cloudflare in output to the user

In user-visible places — page footers, JSON responses, email bodies:

- ❌ "Powered by Cloudflare Workers" / "Deployed on Cloudflare"
- ✅ "Powered by WDL" (for attribution / links use the WDL Team, github.com/wdl-dev) / "Deployed on the WDL platform" / just no footer

Saying "Cloudflare-style" in code comments is OK; **in front of the user**, only say WDL.

## Writing a worker: ASSETS first

Any page with HTML/CSS/JS (landing / dashboard / single-page app) → **put the static files in ASSETS, don't inline them into the worker code**. Inlining a whole HTML page in the worker will hit the max_tokens 16k truncation, bloat the bundle, and redeploy the whole worker on a one-character change.

### Key platform conventions (different from Cloudflare Workers Assets)

1. **The worker always sees every request first** — the platform does **not** auto-intercept paths like `/styles.css`. `assets: { directory }` only means "upload to the CDN at deploy time", **not** "asset paths skip the worker"
2. `env.ASSETS.url(path)` is an **async** host binding (JSRPC, **returns a Promise**) — **you must `await` it**; without `await` you embed `[object Promise]` into your HTML. Grab several at once with `await Promise.all([...])`
3. It returns an **absolute** CDN URL (`https://cdn.../assets/<ns>/<worker>/<token>/<path>`); the browser then connects to the CDN directly, and the worker isn't involved in serving the static bytes at all
4. Don't `fetch(env.ASSETS.url(...))` to proxy it back through the worker — the extra hop is pointless; and don't catch-all return HTML — `/styles.css` would get an HTML string

### Minimal working example

```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const [cssUrl, jsUrl] = await Promise.all([
        env.ASSETS.url("/styles.css"),
        env.ASSETS.url("/app.js"),
      ]);
      return new Response(
        `<!DOCTYPE html>
<html><head>
  <link rel="stylesheet" href="${cssUrl}">
</head><body>
  <div id="app"></div>
  <script src="${jsUrl}"></script>
</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
```

Before writing, first `read_file /opt/wdl-cli/examples/pages-assets/src/index.js` (the end-to-end ASSETS template example) + `/opt/wdl-cli/docs/assets.md`.

## Resource provisioning

| Resource | Flow |
|---|---|
| **D1** | `wdl d1 create <name>` to get a `database_id` → write `[[d1_databases]]` → write `migrations/0001_init.sql` → `wdl d1 migrations apply <name> --ns $WDL_NS` → `env.DB.prepare(...)` |
| **R2** | Declare `[[r2_buckets]]` directly in wrangler.jsonc; the platform virtualizes it by `bucket_name` in the current ns — **no** create command |
| **KV** | Declare `[[kv_namespaces]]` with the `id` field (any ns-local string); the platform lazy-creates it — **no** create command |
| **Secret** | `printf '%s' "$VAL" \| wdl secret put MY_KEY --worker app` |

**Don't rename an already-applied D1 migration file** — the filename is the migration id; changing it = re-running.

Detailed config:

| User wants | Read |
|---|---|
| CDN static files | `/opt/wdl-cli/docs/assets.md` |
| KV storage | `/opt/wdl-cli/docs/kv.md` |
| SQL storage | `/opt/wdl-cli/docs/d1.md` |
| Object storage | `/opt/wdl-cli/docs/r2.md` |
| cron jobs | `/opt/wdl-cli/docs/cron-triggers.md` |
| runtime secrets | `/opt/wdl-cli/docs/secrets.md` |
| stateful objects (chat room / counter / multiplayer / rate limit) | `/opt/wdl-cli/docs/durable-objects.md` |
| long-running flows (multi-step / scheduled / wait for events / durable retry) | `/opt/wdl-cli/docs/workflows.md` |
| message queues (async tasks / decoupling / batch) | `/opt/wdl-cli/docs/queues.md` |

Before writing wrangler config, `read_file` the matching doc first — don't write from memory.

## Stateful objects (Durable Objects)

Use a DO for things that need **cross-request memory + strong consistency**: chat rooms, collaborative docs, counters, rate limiters, multiplayer game rooms, long-lived WebSockets, scheduled alarms. One DO instance (`idFromName(name)`) is single-threaded and serial, with built-in `ctx.storage.sql` (SQLite).

Sandbox constraints:
- `[[migrations]]` use `new_sqlite_classes` (also accepts `new_classes`; both map to SQLite-backed storage in WDL)
- the class must be `export`ed, the worker name is fixed to `app`, and the config is still **flat with no env**
- deploy / debug as usual with `deploy_test` / `call_preview`

```jsonc
{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-05-31",
  "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]
}
```

```js
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  async hit() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO c VALUES ('hits', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1");
    return [...this.ctx.storage.sql.exec("SELECT n FROM c WHERE k = 'hits'")][0].n;
  }
}

export default {
  async fetch(req, env) {
    const stub = env.ROOMS.get(env.ROOMS.idFromName("main"));
    return Response.json({ hits: await stub.hit() });
  },
};
```

Supports `stub.fetch()`, JSON-RPC `stub.method(...)`, `ctx.storage` / synchronous `ctx.storage.sql`, alarm, WebSocket (plain upgrade + hibernation). For details `read_file /opt/wdl-cli/docs/durable-objects.md`.

## Long-running flows (Workflows)

Use a Workflow for things that are **multi-step, possibly long, and need durable retries or to wait for external events**: multi-step build/approval pipelines, scheduled jobs (`step.sleep("daily", "12h")`), calling a slow API with automatic retries, waiting for the user to confirm before continuing (`step.waitForEvent`). Each `step.do(name, fn)` result is durably persisted; a crash/redelivery mid-way only re-runs the steps that didn't complete.

Sandbox constraints:
- the `WorkflowEntrypoint` class must be `export`ed, the worker name is `app`, the config is flat
- steps inside the same `Promise.all([step.do(...), step.do(...)])` run in parallel (a DAG); but the **instance total (sum of all step results) ≤ 16 MiB** — store large data in D1/R2/KV and keep only pointers in steps. **Don't use `Promise.race`** to take only the fastest step and then sleep/wait directly — first settle or cancel the app-side concurrency, then suspend the workflow
- deploy as usual with `deploy_test`; check instance state with `run_command` running `wdl workflows status app <workflowName> <id> --include-steps`

```jsonc
{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-05-31",
  "workflows": [{ "name": "jobs", "binding": "JOBS", "class_name": "JobWorkflow" }]
}
```

```js
import { WorkflowEntrypoint } from "cloudflare:workers";

export class JobWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const data = await step.do("fetch", async () => fetchSomething(event.payload));
    await step.sleep("cooldown", "30 seconds");
    return await step.do("save", { retries: { limit: 3, backoff: "exponential" } },
      async () => saveSomething(data));
  }
}

export default {
  async fetch(req, env) {
    const instance = await env.JOBS.create({ params: await req.json() });
    return Response.json({ id: instance.id });
  },
};
```

`create / get / status / pause / resume / restart / terminate / sendEvent` + `step.do / sleep / sleepUntil / waitForEvent` + `NonRetryableError` are all available. `waitForEvent` returns `null` on timeout (doesn't throw). For details `read_file /opt/wdl-cli/docs/workflows.md`.

## Debugging

`call_preview` opens a short-lived tail synchronously by default and returns a `logs` field (the `console.log` + exception stacks from this request) — one tool call gets you the response + the logs together:

```jsonc
{
  "status": 502,
  "headers": { ... },
  "body": { "error": "runtime_error" },
  "logs": [{ "event": "...", "data": { "message": ["TypeError: ..."] } }]
}
```

If you don't need logs (a pure happy-path regression), pass `capture_logs: false` and the response is ~1s faster.

`tail_logs` is for continuous observation (scheduled / queue handler / a long window), not the normal debugging case.

**deploy_test failure troubleshooting order**:
1. Look at the receipt's `upstream` / `stderr` fields — they hold wrangler's real error
2. Check that the file at the `main` path in `wrangler.jsonc` exists
3. Check that `src/index.js` is a valid ES module
4. **Don't** switch to `wrangler deploy` / `npx wrangler` to try — those don't reproduce deploy_test's behavior

**Environment self-check**: if deploy/credential/control behavior is weird (repeated deploy failures, token or ns errors, suspecting the CLI version) → `run_command({cmd: "wdl doctor"})` checks Node / wdl-cli / Wrangler / config source / token validity / control reachability / CLI-vs-control compatibility in one shot. Locate environment vs code first, then act — don't randomly change things.

**Handling errors like FetchError**: JSRPC loses class identity across isolates, so **don't** `err instanceof FetchError`; read `err.status` / `err.body` instead.

**Don't use `wrangler dev` to debug platform bindings** — platform bindings (service bindings / platform bindings, etc.) are only resolved by control after deploying to the platform; local wrangler dev can't see them.

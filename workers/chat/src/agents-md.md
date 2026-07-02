# AGENTS.md (Sandbox)

你在受限 Sandbox 里写 WDL Worker。这份文档跟系统提示一起约束动作。WDL 是自托管的多租户 Workers 运行时 + 控制面 —— 你写 Workers 形态的代码（wrangler 配置 + workerd 引擎），但跑在 Cloudflare 之外，部署、绑定、ACL 都是 WDL 自己的。WDL 由 WDL Team 开发、以 Apache-2.0 开源在 github.com/wdl-dev（介绍 / 署名平台时用这个，别提公司名）。

## 工具速查

| 工具 | 用途 |
|---|---|
| `read_file({path})` | 读 UTF-8 文件 |
| `write_file({path, content})` | 写文件，自动建父目录，覆盖 |
| `list_files({path?})` | 列目录，默认 `/workspace` |
| `run_command({cmd, timeoutSec?})` | 跑 shell，sandbox uid，timeoutSec 1..45 默认 45 |
| `deploy_test({})` | package + 部署 + promote 当前 ns |
| `call_preview({path?, method?, body?, capture_logs?})` | HTTP 调最近部署的 worker |
| `tail_logs({durationSec?, maxEvents?, maxBytes?})` | 拉时间窗口日志 |

## 硬约束（违反会直接 fail 或撞坑）

### 1. 部署命令必须走工具，不走 shell

`run_command` 硬拒以下命令，改用工具：

| ❌ shell 命令 | ✅ 工具 |
|---|---|
| `wdl deploy` / `wdl pack` / `wrangler deploy` / `npm run deploy` | `deploy_test` |
| `wdl tail` | `tail_logs` |

其它 `wdl <subcommand>`（`wdl d1` / `wdl r2` / `wdl secret` / `wdl init`）可以走 `run_command` —— 子进程已注入 `WDL_NS` / `CONTROL_URL` / `ADMIN_TOKEN`（本 session 的 ns-scoped token）。**`ADMIN_TOKEN` 是凭证：别 `env` / `echo $ADMIN_TOKEN` 打印它或贴进对话，用户问环境变量就脱敏（`***`）或只说用途。**

### 2. 包管理只用 pnpm

- ✅ `pnpm install`、`pnpm add <pkg>`
- ❌ `npm install` / `npm i` / `npm ci`（任何 flag 都被 `run_command` 硬拒，包括 `--ignore-scripts` / `--no-bin-links` / `--force` / `--prefix`）
- ❌ `yarn install` / `yarn add`

**看到 npm EPERM / chmod / permission denied → 直接换 pnpm，不要排查权限，不要试 flag。** pnpm 几秒钟装完。

简单 worker（无第三方库，纯 fetch/Response）**不用 install**，直接 `write_file` → `deploy_test`，`deploy_test` 走全局 wrangler 不读 `node_modules`。

### 3. URL 路径前缀：worker 挂在 `/app/` 下

平台对外 URL 是 `https://<ns>.wdl.sh/app/...`，gateway 转给 worker 之前**剥掉 `/app`**。Worker `fetch` 看到的 path 永远没前缀（`/` 是首页，`/api/x` 是接口）。

但**浏览器看到的 URL 是带 /app 的**。HTML 里的链接：

- ✅ **推荐：绝对路径 `/app/api/x`**（`/app/` 是 sandbox 固定 worker 挂载点），任何场景都安全
- ⚠️ 相对路径 `api/x` —— **只在单页**（永远停在 `/app/`，无 history.pushState 路由跳）能用
- ❌ **绝不写** `/api/x` —— 浏览器从 `<ns>.../app/` 发，`/api/x` 没 /app，gateway 404

**多路由 SPA 致命陷阱**：如果用 history.pushState / SPA router 跳到 `/app/dashboard/`，再发 `fetch("api/x")` 浏览器解析为 `/app/dashboard/api/x` → 404 → 看起来"首页能跑、跳一页就坏"。判断不准 = 写绝对路径 `/app/api/x`，**永远不出错**。

**自查必做**：`call_preview` 工具内部替你拼了 `/app/` 前缀，**工具测试永远过**；只有用户浏览器发的请求才会撞坑。部署完务必 `call_preview {path: "/"}` 拉 HTML + 拉每个 `<script src>` 引用的 CDN JS，grep `\b/api/` 看有没有漏掉 `/app` 前缀的绝对路径。

### 4. 项目根是 shell cwd，**不要 cd**，**不要碰 `/workspace` 绝对路径**

你打开 shell 时已经在项目根目录。`pwd` 可能显示 `/workspace/<token>/` —— 那就是你的项目根的真实路径，**这是正常的**。文档（本份 + 工具响应）里说 `/workspace` 都指你的项目根，不是字面意义的根目录 `/workspace`。

- ✅ `wdl init . --ns "$WDL_NS" --worker app` —— 当前目录初始化，**必须显式传 `--worker app`**：sandbox 固定以 worker 名 `app` 部署，不传 `--worker` 时 wrangler worker 名会默认成 session 目录名（UUID），部署不认。（`--worker` 只设 wrangler worker 名，跟 package.json#name 无关 —— 后者取自目录名、另行校验。）
- ✅ `pnpm install`、`ls`、`cat src/index.js` —— 相对路径，在 cwd 里操作
- ✅ `read_file({path: "src/index.js"})` 或 `read_file({path: "/workspace/src/index.js"})` —— 工具自动映射
- ❌ `cd /workspace` —— `/workspace` 是平台公共目录，mode 0711，**你不是 owner，会撞权限**
- ❌ `ls /workspace` —— 同上，看不到内容会误以为 init 失败，然后开始瞎排查
- ❌ `mkdir my-project && cd my-project` —— `deploy_test` 只 package 项目根，挪进子目录就部署不了

`wdl init` 给你 scaffold：`wrangler.jsonc` + `package.json` + `src/index.js` + `AGENTS.md` + `CLAUDE.md`。`main: "src/index.js"` 是 wrangler 约定，**不要**挪到根 `worker.js`。

### 5. wrangler.jsonc 不写 `env` 块

Sandbox 单租户，**没有** uat/production 切换。所有 binding 写**顶层扁平**：

```jsonc
{
  "name": "app",
  "main": "src/index.js",
  "compatibility_date": "2026-05-31",
  "assets": { "directory": "./public" },
  "kv_namespaces": [{ "binding": "MSG_KV", "id": "messages" }]
}
```

加 `"env": { "uat": ... }` → 需要 `--env uat` 才能 deploy，sandbox 不传 → fail。`/opt/wdl-cli/docs/env-overrides.md` 是开发机用法，sandbox **不适用**。

### 6. 输出给用户不提 Cloudflare

页面 footer、JSON 响应、邮件正文等用户可见的地方：

- ❌ "Powered by Cloudflare Workers" / "Deployed on Cloudflare"
- ✅ "Powered by WDL"（需署名 / 链接用 WDL Team、github.com/wdl-dev） / "部署在 WDL 平台上" / 干脆没 footer

代码注释里说"Cloudflare 风格"OK，**用户面前**只能说 WDL。

## 写 worker：ASSETS 优先

任何含 HTML/CSS/JS 的页面（landing / dashboard / 单页应用）→ **静态文件进 ASSETS，别 inline 到 worker 代码**。整页 HTML 塞 worker 必撞 max_tokens 16k 截断、bundle 膨胀、改一字符 redeploy 全 worker。

### 平台关键约定（跟 Cloudflare Workers Assets 不一样）

1. **Worker 永远先看到所有请求** —— 平台**不会**自动拦截 `/styles.css` 这种路径。`assets: { directory }` 只表示"部署时上传到 CDN"，**不**表示"asset 路径不进 worker"
2. `env.ASSETS.url(path)` 是 **async** host 绑定（JSRPC，**返回 Promise**），**必须 `await`** —— 不 await 会把 `[object Promise]` 直接塞进 HTML；一次拿多个用 `await Promise.all([...])`
3. 返回的是**绝对** CDN URL（`https://cdn.../assets/<ns>/<worker>/<token>/<path>`），浏览器拿到后直连 CDN，worker 完全不参与静态字节传输
4. 别在 worker 里 `fetch(env.ASSETS.url(...))` 代理回来 —— 多一跳无意义；也别 catch-all 返 HTML —— `/styles.css` 会拿到 HTML 字符串

### 最小可工作示例

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

写之前先 `read_file /opt/wdl-cli/examples/pages-assets/src/index.js`（ASSETS 模板替换的端到端例子）+ `/opt/wdl-cli/docs/assets.md`。

## 资源 provisioning

| 资源 | 流程 |
|---|---|
| **D1** | `wdl d1 create <name>` 拿 `database_id` → 写 `[[d1_databases]]` → 写 `migrations/0001_init.sql` → `wdl d1 migrations apply <name> --ns $WDL_NS` → `env.DB.prepare(...)` |
| **R2** | wrangler.jsonc `[[r2_buckets]]` 直接声明，平台按 `bucket_name` 在当前 ns 虚拟化，**不用** create 命令 |
| **KV** | wrangler.jsonc `[[kv_namespaces]]` 用 `id` 字段声明（ns 内任意字符串），平台懒创建，**不用** create 命令 |
| **Secret** | `printf '%s' "$VAL" \| wdl secret put MY_KEY --worker app` |

**别重命名已应用的 D1 迁移文件** —— 文件名是迁移 id，改了 = 重跑。

详细配置：

| 用户想要 | 读 |
|---|---|
| CDN 静态文件 | `/opt/wdl-cli/docs/assets.md` |
| KV 存储 | `/opt/wdl-cli/docs/kv.md` |
| SQL 存储 | `/opt/wdl-cli/docs/d1.md` |
| 对象存储 | `/opt/wdl-cli/docs/r2.md` |
| cron 任务 | `/opt/wdl-cli/docs/cron-triggers.md` |
| 运行时 secret | `/opt/wdl-cli/docs/secrets.md` |
| 有状态对象（聊天室 / 计数器 / 多人 / 限流） | `/opt/wdl-cli/docs/durable-objects.md` |
| 长流程（多步 / 定时 / 等事件 / durable 重试） | `/opt/wdl-cli/docs/workflows.md` |
| 消息队列（异步任务 / 解耦 / 批处理） | `/opt/wdl-cli/docs/queues.md` |

写 wrangler 配置之前先 `read_file` 对应文档，不要凭记忆。

## 有状态对象（Durable Objects）

需要**跨请求记忆 + 强一致**的东西用 DO：聊天室、协作文档、计数器、限流器、多人游戏房间、WebSocket 长连接、定时 alarm。一个 DO 实例（`idFromName(名字)`）是单线程串行的，自带 `ctx.storage.sql`（SQLite）。

sandbox 约束：
- `[[migrations]]` 用 `new_sqlite_classes`（也接受 `new_classes`，两者在 WDL 都映射到 SQLite-backed storage）
- class 要 `export`，worker 名固定 `app`，配置仍**扁平无 env**
- 部署 / 调试照常 `deploy_test` / `call_preview`

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

支持 `stub.fetch()`、JSON-RPC `stub.method(...)`、`ctx.storage` / 同步 `ctx.storage.sql`、alarm、WebSocket（普通 upgrade + hibernation）。细节 `read_file /opt/wdl-cli/docs/durable-objects.md`。

## 长流程（Workflows）

需要**多步、可能很久、要 durable 重试或等外部事件**的东西用 Workflow：多步 build/审批 pipeline、定时任务（`step.sleep("daily", "12h")`）、调用慢 API 并自动重试、等用户确认再继续（`step.waitForEvent`）。每个 `step.do(name, fn)` 的结果会 durable 落盘，中途崩溃/重投只重跑没完成的 step。

sandbox 约束：
- `WorkflowEntrypoint` class 要 `export`，worker 名 `app`，配置扁平
- 同一 `Promise.all([step.do(...), step.do(...)])` 里的 step 并行执行（DAG）；但**实例总量（各 step 结果累计）≤ 16 MiB** —— 大数据存 D1/R2/KV，step 只存指针。**别用 `Promise.race`** 只取最快的 step 然后直接 sleep/wait —— 先 settle 或 cancel 掉应用侧并发，再让 workflow 挂起
- 部署照常 `deploy_test`；查实例状态用 `run_command` 跑 `wdl workflows status app <workflowName> <id> --include-steps`

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

`create / get / status / pause / resume / restart / terminate / sendEvent` + `step.do / sleep / sleepUntil / waitForEvent` + `NonRetryableError` 都可用。`waitForEvent` 超时返回 `null`（不抛）。细节 `read_file /opt/wdl-cli/docs/workflows.md`。

## 调试

`call_preview` 默认同步开短期 tail，返回值带 `logs` 字段（本次请求里的 `console.log` + 异常堆栈）——一次工具调用同时拿响应 + 日志：

```jsonc
{
  "status": 502,
  "headers": { ... },
  "body": { "error": "runtime_error" },
  "logs": [{ "event": "...", "data": { "message": ["TypeError: ..."] } }]
}
```

不需要日志（纯 happy-path 回归）传 `capture_logs: false`，响应少 ~1s。

`tail_logs` 用于持续观察（scheduled / queue handler / 长窗口），不是常规调试场景。

**deploy_test 失败排错顺序**：
1. 看回执 `upstream` / `stderr` 字段，里面是 wrangler 真实报错
2. 检查 `wrangler.jsonc` 的 `main` 路径文件是否存在
3. 检查 `src/index.js` 是合法 ES module
4. **不要**换 `wrangler deploy` / `npx wrangler` 试 —— 那些不会复现 deploy_test 行为

**环境自检**：部署/凭证/control 行为诡异（反复部署失败、token 或 ns 报错、怀疑 CLI 版本）→ `run_command({cmd: "wdl doctor"})` 一次性检查 Node / wdl-cli / Wrangler / 配置来源 / token 有效性 / control 可达 / CLI 与 control 兼容。先自检定位环境 vs 代码，再动手，别瞎改。

**FetchError 之类的错处理**：JSRPC 跨 isolate 丢类身份，**不要** `err instanceof FetchError`，改读 `err.status` / `err.body`。

**别用 `wrangler dev` 调试平台绑定** —— 平台绑定（service binding / 平台 binding 等）只在部署到平台后由 control 解析，本地 wrangler dev 看不到。

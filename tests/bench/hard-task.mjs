// Model-selection benchmark — NOT a regression test, and deliberately outside `npm test` / `test:e2e`.
//
// Why it exists: the two e2e demos pass on every model tier we have tried, so they cannot tell a
// good model from a bad one. This task can. It asks for an ASSETS page + four JSON endpoints + KV +
// input validation, and every acceptance check is machine-decidable.
//
// The discriminator is the gateway prefix trap: the app is served at <ns>.wdl.sh/app/ and the worker
// sees the path with /app already stripped, so a page that fetches a root-absolute "/api/..." 404s in
// a real browser. `call_preview` cannot catch it — the tool prepends /app/ itself, so tool-side
// verification always passes. Only a model that read AGENTS.md and reasoned about it gets this right.
//
// Usage (needs a live stack, same env as tests/e2e):
//   WDL_CHAT_BASE_URL=... WDL_CHAT_PASSCODE=... npm run bench -- [runs] [label]
//
// Each run opens a session that holds a tmp ns for its full 6h lifetime (Close does not revoke), so
// a 4-run sweep costs 4% of the 100-session active quota. Check with the operator before big sweeps.
// A run that passes every in-deploy check sends one follow-up turn (a plain redeploy) to verify
// persistence across versions.

import { awaitRunDone, closeSession, createSession, postMessage, BASE, HAS_E2E_BASE } from "../e2e/_helpers.js";

const PROMPT = [
  "做一个 todo 应用，前端页面 + JSON API + KV 持久化：",
  "- 页面的 CSS/JS 走 ASSETS，不要把所有前端代码内联进 Worker；页面里用 fetch 调用自己的 API 并渲染列表",
  "- GET  /api/todos             → { todos: [...] }",
  "- POST /api/todos             → body { title }，新增后返回 { id, title, done: false }",
  "- POST /api/todos/<id>/toggle → 切换 done，返回该条 todo",
  "- title 缺失或为空串 → 400 { error: \"title required\" }",
  "- 所有 todo 用 KV 持久化，重新部署前后数据保持",
  "完成标准：deploy_test 之后，用 call_preview 验证四个端点行为都正确；",
  "并且确认在浏览器里打开预览页时，页面自己发出的 fetch 请求能真的打到 API（不是 404）。",
].join("\n");

// A root-absolute /api that is not under /app/ never reaches the worker from a browser. Only
// delimiter-adjacent occurrences count (quote/backtick/paren/equals): those are fetch targets or
// attribute values, while bare prose like "GET /api/todos" in on-page endpoint docs is not. The
// /app-prefixed form never matches because the delimiter is followed by /app, not /api.
const BARE_API = /["'`(=]\/api[/"'`]/;
// A reachable API path literal: "/app/api..." (absolute), or "api/" / "./api/" (relative — valid on
// a single page). The trailing class forbids a bare word, so data-kind="api" doesn't count; bare
// "/api/ stays unmatched (the char after the delimiter is "/", not "a").
const GOOD_API = /["'`]\/app\/api[/"'`]|["'`](?:\.\/)?api\//;
// This is still static analysis, not execution — proving the page actually fires the request needs a
// browser. Requiring BOTH a fetch-like call and a reachable path is the closest cheap approximation:
// a static page of href links has the path but no call site.
const HAS_FETCH = /\bfetch\s*\(|XMLHttpRequest/;

// Per-probe deadline: a generated worker with a hanging handler (or an unbounded response body)
// must fail the run, not stall the benchmark while the session keeps its MicroVM alive.
const PROBE_TIMEOUT_MS = 15_000;
async function text(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  return { status: r.status, body: await r.text() };
}

// The trap hides in the CDN bundle as often as in the HTML — checking only the HTML misses it.
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function scriptSources(pageUrl, html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try { out.push(new URL(m[1], pageUrl).href); } catch { /* unresolvable src */ }
  }
  return out;
}

async function runOnce(label) {
  const t0 = Date.now();
  const out = { label, ok: false };
  let session = null;
  try {
    session = await createSession();
    out.ns = session.ns;
    const { runId } = await postMessage(session.sessionId, PROMPT);
    const { terminal, preview, events } = await awaitRunDone(session.sessionId, runId, { timeoutMs: 10 * 60_000 });
    out.sec = +((Date.now() - t0) / 1000).toFixed(1);
    out.terminal = terminal.event;
    if (terminal.data?.error) out.error = terminal.data.error;

    const turns = events.filter(e => e.event === "message.assistant" && !e.data?.replay && Array.isArray(e.data?.content));
    const seq = turns.flatMap(t => t.data.content.filter(b => b?.type === "tool_use").map(b => ({ name: b.name, input: b.input ?? {} })));
    out.turns = turns.length;
    out.tools = seq.length;
    out.deploys = seq.filter(c => c.name === "deploy_test").length;   // > 1 means it had to rework
    out.previews = seq.filter(c => c.name === "call_preview").length;
    // Only probes AFTER the LAST deploy count: the scored version is the final one, and probes
    // against an earlier deploy verified code that no longer exists (deploy → probe → fix →
    // redeploy → no re-check must not pass).
    const lastDeploy = seq.findLastIndex(c => c.name === "deploy_test");
    const probes = lastDeploy === -1 ? [] : seq.slice(lastDeploy + 1)
      .filter(c => c.name === "call_preview").map(c => c.input);

    if (terminal.event !== "run.done" || !preview?.previewUrl) {
      out.fail = out.error ?? `terminal ${terminal.event} without a preview`;
      return out;
    }

    const url = preview.previewUrl;
    const post = (p, body) => text(url + p, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const checks = {};

    // 200 or 201 — the prompt never specifies a status, and 201 is the more correct one for a create.
    const created = await post("api/todos", { title: "buy milk" });
    const createdRow = parseJson(created.body);
    checks.create = (created.status === 200 || created.status === 201)
      && createdRow?.id != null && createdRow?.title === "buy milk" && createdRow?.done === false;
    const id = createdRow?.id ?? null;

    const list = await text(url + "api/todos");
    const listRows = parseJson(list.body)?.todos;
    checks.list = list.status === 200 && Array.isArray(listRows) && listRows.some(t => t?.id === id);

    // "返回该条 todo" — the full row, so a bare {done:true} acknowledgement fails.
    const toggled = id == null ? { status: 0, body: "" } : await post(`api/todos/${encodeURIComponent(id)}/toggle`);
    const togRow = parseJson(toggled.body);
    checks.toggle = (toggled.status === 200 || toggled.status === 201)
      && togRow?.id === id && togRow?.title === "buy milk" && togRow?.done === true;

    // Both invalid shapes, and the error must be the promised JSON — plain text can't impersonate it.
    const isTitleErr = (r) => {
      const e = parseJson(r.body)?.error;
      return r.status === 400 && typeof e === "string" && e.includes("title required");
    };
    checks.validate = isTitleErr(await post("api/todos", { title: "" }))
      && isTitleErr(await post("api/todos", {}));

    const page = await text(url);
    checks.page = page.status === 200 && /<html|<!doctype/i.test(page.body);

    const bodies = [page.body];
    let scriptsOk = true;
    for (const src of await scriptSources(url, page.body)) {
      const js = await text(src).catch(() => null);
      // A script that fails to load — or serves an HTML fallback page — means the page's fetches
      // never run, so browser-correctness cannot be claimed. Only a LEADING doctype/<html counts as
      // a fallback: legit bundles carry HTML in template strings.
      if (!js || js.status !== 200 || /^\s*(?:<!doctype|<html)/i.test(js.body)) { scriptsOk = false; break; }
      bodies.push(js.body);
    }
    const clientCode = bodies.join("\n");
    checks.prefix = checks.page && scriptsOk && !BARE_API.test(clientCode);
    // Positive condition, not just absence-of-bad: a pure-static page with no API call at all
    // must not pass the browser check by vacuity.
    checks.callsApi = HAS_FETCH.test(clientCode) && GOOD_API.test(clientCode);
    // The ASSETS requirement (CSS/JS as assets, not everything inlined), judged by the platform's
    // own deploy manifest — an all-inline build deploys zero assets. The HTML shell itself staying
    // in the worker is the platform-canonical pattern: there is no asset request interception, and
    // redirecting to the CDN would break the page's relative api/ fetches.
    checks.assets = (preview.artifactMeta?.assetCount ?? 0) >= 1;
    // The completion standard names call_preview verification of all four endpoint behaviours —
    // four DISTINCT post-deploy probes, not four calls: a GET list, a POST create with a real
    // title, a POST toggle, and a POST exercising the 400 (missing/empty title).
    const P = (x) => String(x?.path ?? "/");
    const M = (x) => String(x?.method ?? "GET").toUpperCase();
    const B = (x) => {
      const b = x?.body;
      if (b && typeof b === "object") return b;
      if (typeof b === "string") return parseJson(b);
      return null;
    };
    const todosPath = (x) => P(x).includes("todos") && !P(x).includes("toggle");
    const realTitle = (x) => typeof B(x)?.title === "string" && B(x).title.trim() !== "";
    checks.verified =
      probes.some(x => M(x) === "GET" && todosPath(x))
      && probes.some(x => M(x) === "POST" && todosPath(x) && realTitle(x))
      && probes.some(x => M(x) === "POST" && P(x).includes("toggle"))
      && probes.some(x => M(x) === "POST" && todosPath(x) && !realTitle(x));

    out.checks = checks;
    out.ok = Object.values(checks).every(Boolean);

    // The prompt's one cross-deploy promise — and exactly what an in-memory Map fakes within a
    // single deploy. Ask for a plain redeploy and check the todo created above survived into the
    // new version's isolate. Only reached when everything else passed (no wasted LLM turn).
    if (out.ok) {
      const { runId: rerunId } = await postMessage(session.sessionId, "再执行一次 deploy_test 重新部署（不要改任何代码），部署完成即可。");
      const rerun = await awaitRunDone(session.sessionId, rerunId, { timeoutMs: 5 * 60_000 });
      // run.done alone proves nothing — a model that just replies "完成" leaves the old isolate
      // (and its in-memory Map) serving. Require a fresh, non-replay deploy, on a new version when
      // both versionIds are known.
      const redeploys = rerun.events.filter(e => e.event === "preview.ready" && !e.data?.replay);
      const newVersion = redeploys.at(-1)?.data?.versionId;
      const reallyDeployed = rerun.terminal.event === "run.done" && redeploys.length > 0
        && (newVersion == null || preview.versionId == null || newVersion !== preview.versionId);
      const after = reallyDeployed ? await text(url + "api/todos") : { status: 0, body: "" };
      // The row surviving is not enough — the toggle write must survive too, or a KV-create +
      // in-memory-toggle implementation (or a faked {done:true} response) passes.
      let row = null;
      if (after.status === 200) {
        try { row = (JSON.parse(after.body).todos ?? []).find(t => t?.id === id) ?? null; } catch { /* not the contract */ }
      }
      checks.persist = row != null && row.title === "buy milk" && row.done === true;
      out.ok = checks.persist;
      out.sec = +((Date.now() - t0) / 1000).toFixed(1);
    }

    if (!out.ok) out.fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(",");
    return out;
  } catch (err) {
    out.sec = +((Date.now() - t0) / 1000).toFixed(1);
    out.fail = err.message.slice(0, 140);
    return out;
  } finally {
    if (session) await closeSession(session.sessionId).catch(() => {});
  }
}

if (!HAS_E2E_BASE) {
  console.error("WDL_CHAT_BASE_URL is not set — see the header for usage.");
  process.exit(2);
}

const runs = Math.max(1, Number(process.argv[2]) || 1);
const label = process.argv[3] ?? "run";
console.error(`# ${BASE} — ${runs} run(s), each holds a tmp ns for 6h`);

const results = [];
for (let i = 1; i <= runs; i++) {
  const r = await runOnce(`${label}#${i}`);
  results.push(r);
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`${mark} ${r.label.padEnd(14)} ${String(r.sec).padStart(6)}s  turns=${r.turns ?? "-"} tools=${r.tools ?? "-"} deploys=${r.deploys ?? "-"}  ${r.ok ? "" : `← ${r.fail}`}`);
  // The full record (ns, per-check booleans, probe counts) — diagnosing a FAIL needs it, and the ns
  // is the handle for finding the session afterwards.
  if (!r.ok) console.error(`# ${JSON.stringify(r)}`);
}

const passed = results.filter(r => r.ok).length;
const timed = results.filter(r => typeof r.sec === "number");
const avg = timed.length ? (timed.reduce((n, r) => n + r.sec, 0) / timed.length).toFixed(1) : "-";
console.log(`\n${passed}/${results.length} passed, avg ${avg}s`);
process.exit(passed === results.length ? 0 : 1);

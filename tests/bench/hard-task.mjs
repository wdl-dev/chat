// Model-selection benchmark — NOT a regression test, and deliberately outside `npm test` / `test:e2e`.
//
// Why it exists: the two e2e demos pass on every model tier we have tried, so they cannot tell a
// good model from a bad one. This task can. It asks for an ASSETS page + four JSON endpoints + KV +
// input validation, and every acceptance check is machine-decidable.
//
// The discriminator is the gateway prefix trap: the app is served at <ns>.wdl.sh/app/ and the worker
// sees the path with /app already stripped, so a page that fetches a root-absolute "/api/..." 404s in
// a real browser. `call_preview` cannot catch it — the tool prepends /app/ itself, so tool-side
// verification always passes. A headless Chromium (browser-judge.mjs) proves it by execution: the
// page must load, its canonical asset code must request the API on the correct path, and a
// response-only witness todo from that same fetch must actually render. Static analysis is limited
// to deterministic facts (manifest ownership, deploy tokens, artifact digests) — simulating
// browser semantics in the bench was tried at length and only ever proved conformance with the
// simulation.
//
// Usage (needs a live stack + `npx playwright install chromium`, same env as tests/e2e):
//   WDL_CHAT_BASE_URL=... WDL_CHAT_PASSCODE=... npm run bench -- [runs] [label]
// WDL_ASSETS_HOST overrides the trusted assets-CDN host[:port] (default assets.wdl.dev) for a
// self-hosted / staging stack.
//
// Each run opens a session that holds a tmp ns for its full 6h lifetime (Close does not revoke), so
// a 4-run sweep costs 4% of the 100-session active quota. Check with the operator before big sweeps.
// A run that passes every in-deploy check sends four more turns, each gated on the previous round
// passing so a failing model wastes no turns: a plain redeploy (does KV really persist across
// versions?), a specified change (can it add a route without breaking the rest?), an open-ended
// one (can it act on an ask that names no acceptance test, and not take the app down?), and a
// final plain redeploy that audits the last version's mutations for persistence. The open-ended
// turn is the one that actually separates models — see OPEN_ENDED.

import { awaitRunDone, closeSession, createSession, postMessage, BASE, HAS_E2E_BASE } from "../e2e/_helpers.js";
import { createBrowserJudge } from "./browser-judge.mjs";
import {
  browserOk, changedCode, currentAssetToken, deployedAssetsOk, digestMapChanged, rotatedAssetsOk,
  rowIdentityAbsent, sameCode, todoProbeKind,
} from "./hard-task-logic.mjs";

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

const REDEPLOY = "再执行一次 deploy_test 重新部署（不要改任何代码），部署完成即可。";

// States the contract (machine-decidable) and nothing about process — no tool named, no "then
// deploy". Deciding to act and to ship is part of what's measured; spelling out the steps hands
// the model that decision.
const INCREMENT = [
  "再加个删除：",
  "- DELETE /api/todos/<id> → 删掉这一条，返回 { ok: true }",
  "其余行为和页面别动。",
].join("\n");

// Verbatim from a real session where a model answered it with a summary of work it had not done.
// Underspecified is the point (no file, no API, no acceptance test named); ambiguous is a bug — a
// restyle is actionable without asking, whereas "加个小demo" on a todo app legitimately invites
// "which one?" and scored that good judgement as failure.
const OPEN_ENDED = "样式再cyberpunk点";
const OPEN_WITNESS_TITLE = "feed cat";

// Every probe target is model-emitted output, so the probe itself is a boundary. Three rules,
// applied to ALL fetches (page, API, assets alike):
// - a deadline, so a hanging handler fails the run instead of stalling the benchmark;
// - no redirects — the contract needs none, and following one would let a generated 302 aim the
//   bench host at loopback/metadata targets;
// - a byte cap enforced while streaming (cancel at the limit, not read-all-then-truncate), and a
//   capped body reports status 599 so every status-code check fails closed rather than judging a
//   truncated payload as the complete response.
const PROBE_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;
async function readBody(r) {
  const reader = r.body?.getReader();
  if (!reader) return { body: "", truncated: false };
  const chunks = [];
  let bytes = 0, truncated = false;
  try {
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_BODY_BYTES - bytes;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      bytes += Math.min(value.byteLength, room);
      if (value.byteLength > room) { truncated = true; break; }
    }
    // Landing exactly on the cap is not truncation — only an extra read can tell a body that ends
    // there from one that continues.
    if (!truncated && bytes >= MAX_BODY_BYTES) truncated = !(await reader.read()).done;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { body: Buffer.concat(chunks).toString("utf8"), truncated };
}
async function text(url, init) {
  const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const { body, truncated } = await readBody(r);
  return { status: truncated ? 599 : r.status, body, truncated };
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

const ASSETS_HOST = process.env.WDL_ASSETS_HOST ?? "assets.wdl.dev";
// The judge is a real headless Chromium (see browser-judge.mjs): what loads, what the page's own
// code requests, and what renders are observed facts, not parsed approximations. Created once per
// bench process, after the env check at the bottom.
let judge = null;

async function inspectPage(url, ns, meta, { witness = true } = {}) {
  return judge.inspect(url, ns, meta, { witness });
}
const safeBrowserUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (!new Set(["http:", "https:", "ws:", "wss:"]).has(u.protocol)) {
      return `${u.protocol}(redacted)`;
    }
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch { return "(invalid URL)"; }
};
const browserEvidence = (snap) => snap == null ? null : {
  pageOk: snap.pageOk,
  apiOk: snap.apiOk,
  witnessRendered: snap.witnessRendered,
  assetTokens: [...(snap.assetTokens ?? [])],
  loadedAssets: [...(snap.loadedAssets ?? [])].map(([path, asset]) => ({ path, ...asset })),
  violations: (snap.violations ?? []).map(v => ({ ...v, url: safeBrowserUrl(v.url) })),
  blockedExternal: (snap.blockedExternal ?? []).map(safeBrowserUrl),
  pageErrors: snap.pageErrors ?? [],
  consoleErrors: snap.consoleErrors ?? [],
};
const recordBrowserFailure = (out, phase, snap) => {
  (out.browser ??= {})[phase] = browserEvidence(snap);
};
const assistantTurns = (events) => events.filter(
  e => e.event === "message.assistant" && !e.data?.replay && Array.isArray(e.data?.content));
const toolCalls = (turns) => turns.flatMap(
  t => t.data.content.filter(b => b?.type === "tool_use").map(b => ({ name: b.name, input: b.input ?? {} })));
// The tool layer treats src/x.js, ./src/x.js and /workspace/src/x.js as the same file (the
// /workspace/ prefix is stripped and the rest resolves against the session dir), so the rewrites
// metric must too. Exactly that prefix — guessing at further components would merge distinct files.
const normPath = (p) => String(p).replace(/^(?:\.\/)+/, "").replace(/^\/workspace\//, "");
const writtenPaths = (calls) => calls.filter(c => c.name === "write_file").map(c => normPath(c.input?.path ?? ""));

// run.done alone proves nothing — a model that just replies "完成" leaves the old isolate (and its
// in-memory Map) serving. Require a fresh, non-replay deploy, on a new version when both ids are
// known. Returns the version now live so the next round can demand a newer one than THIS one.
function redeployed(run, liveVersion) {
  const deploys = run.events.filter(e => e.event === "preview.ready" && !e.data?.replay);
  const last = deploys.at(-1)?.data;
  const ok = run.terminal.event === "run.done" && deploys.length > 0
    && (last?.versionId == null || liveVersion == null || last.versionId !== liveVersion);
  return { ok, versionId: last?.versionId ?? liveVersion, meta: last?.artifactMeta ?? null };
}

// The prompt's HTTP-observable contract. Split out because later rounds re-run the whole set: a
// change that adds DELETE but breaks toggle is not a pass, and probing only the new endpoint is
// exactly how that goes unnoticed. Also returns the created row's id — later rounds delete it or
// read it back across a deploy.
async function probeContract(url, title) {
  const post = (p, body) => text(url + p, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const checks = {};

  // 200 or 201 — the prompt never specifies a status, and 201 is the more correct one for a create.
  const created = await post("api/todos", { title });
  const createdRow = parseJson(created.body);
  checks.create = (created.status === 200 || created.status === 201)
    && createdRow?.id != null && createdRow?.title === title && createdRow?.done === false;
  const id = createdRow?.id ?? null;

  // Full-row match, not id presence: the created row must actually carry this title and done:false
  // in the store, or a create that echoes the response while writing something else passes.
  const list = await text(url + "api/todos");
  const listRows = parseJson(list.body)?.todos;
  checks.list = list.status === 200 && Array.isArray(listRows)
    && listRows.some(t => t?.id === id && t?.title === title && t?.done === false);

  // "返回该条 todo" — the full row, so a bare {done:true} acknowledgement fails.
  const toggled = id == null ? { status: 0, body: "" } : await post(`api/todos/${encodeURIComponent(id)}/toggle`);
  const togRow = parseJson(toggled.body);
  checks.toggle = (toggled.status === 200 || toggled.status === 201)
    && togRow?.id === id && togRow?.title === title && togRow?.done === true;
  // Receipt vs state: a fabricated {done:true} response over an unwritten row passes `toggle` alone.
  const relist = id == null ? { status: 0, body: "" } : await text(url + "api/todos");
  const relistRows = parseJson(relist.body)?.todos;
  checks.toggleApplied = relist.status === 200 && Array.isArray(relistRows)
    && relistRows.some(t => t?.id === id && t?.title === title && t?.done === true);

  // Both invalid shapes, and the error must be the promised JSON — plain text can't impersonate it.
  const isTitleErr = (r) => {
    const e = parseJson(r.body)?.error;
    return r.status === 400 && typeof e === "string" && e.includes("title required");
  };
  checks.validate = isTitleErr(await post("api/todos", { title: "" }))
    && isTitleErr(await post("api/todos", {}));

  const page = await text(url);
  checks.page = page.status === 200 && /<html|<!doctype/i.test(page.body);

  return { checks, id };
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
    out.terminal = terminal.event;
    if (terminal.data?.error) out.error = terminal.data.error;

    const turns = assistantTurns(events);
    const seq = toolCalls(turns);
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
    const { checks, id } = await probeContract(url, "buy milk");

    // Browser facts: the page loads, its own code requests the API on the correct /app/ path (the
    // prefix trap by direct observation), and the response-only witness todo actually renders.
    const snap = await inspectPage(url, session.ns, preview.artifactMeta);
    checks.rendered = checks.page && browserOk(snap);
    // The ASSETS requirement, judged on BOTH sides: the deploy manifest has assets (an all-inline
    // build deploys zero) AND Chromium actually executed this artifact's JS, applied its CSS, and
    // got both from the CDN under one deploy token. The HTML shell staying in the worker is the
    // canonical pattern.
    checks.assets = deployedAssetsOk(snap, preview.artifactMeta);
    if (!checks.rendered || !checks.assets) recordBrowserFailure(out, "initial", snap);
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
    const probeKinds = new Set(probes.map(p => todoProbeKind(p, url)).filter(Boolean));
    checks.verified = ["list", "create", "toggle", "validate"].every(k => probeKinds.has(k));
    // A verified failure with no record of what WAS probed cannot distinguish "the model skipped
    // re-verification" from "the matcher doesn't recognize its probes" — capture the evidence,
    // plus the whole tool tail after the last deploy. A model re-verifying via run_command curl is
    // invisible in `probes`, so record a boolean classification without copying the full command
    // (which may contain credentials or other model-generated data) into benchmark logs.
    if (!checks.verified) {
      out.probes = probes.map(x => ({ method: M(x), path: P(x), body: B(x) }));
      const tail = lastDeploy === -1 ? [] : seq.slice(lastDeploy + 1);
      out.tailAfterDeploy = tail.map(c => c.name);
      out.curlMentionedAfterDeploy = tail.some(c => c.name === "run_command"
        && typeof c.input?.cmd === "string"
        && /(?:^|[^a-z0-9_-])curl(?=$|[^a-z0-9_-])/i.test(c.input.cmd));
    }

    out.checks = checks;
    out.ok = Object.values(checks).every(Boolean);

    // The prompt's one cross-deploy promise — and exactly what an in-memory Map fakes within a
    // single deploy. Ask for a plain redeploy and check the todo created above survived into the
    // new version's isolate. Only reached when everything else passed (no wasted LLM turn).
    let live = preview.versionId;
    let meta = preview.artifactMeta ?? null;
    let liveAssetToken = currentAssetToken(snap);
    // Five data witnesses, one per (version, mutation) pair. A mutation only counts as persisted
    // once its row is read back across a deploy, and every witness is planted BEFORE the deploy it
    // must cross — a row created by the version under test proves nothing in that version's own
    // isolate. water plants is planted before feed cat's delete, so the immediate delete check has
    // no intervening create and can use bare-id absence. The later cross-deploy witness uses id+title:
    // the model's mandatory final re-verification may create a temporary row and legally reuse the id.
    //   buy milk        round-1 code   create+toggle (the persist check itself), then collateral
    //   wash car / pay  round-1 code   the incr version's DELETE target (two planted — a model
    //                                  verifying its new DELETE legitimately picks an existing row
    //                                  as its own test victim, so one may already be gone)
    //   walk dog        incr code      its create+toggle, read back past the open deploy
    //   feed cat        open code      its delete, read back past round 5
    //   water plants    open code      its create+toggle, read back past round 5
    const VICTIM_TITLES = ["wash car", "pay bills"];
    const plantedVictims = [];
    let victim = null;   // the planted row the bench actually deletes, chosen from the survivors
    let incrRowId = null;
    let openId = null;
    let waterId = null;
    if (out.ok) {
      const { runId: rerunId } = await postMessage(session.sessionId, REDEPLOY);
      const rerun = await awaitRunDone(session.sessionId, rerunId, { timeoutMs: 5 * 60_000 });
      const again = redeployed(rerun, live);
      live = again.versionId;
      // "不要改任何代码" is part of what's measured: persistence proven against silently-changed
      // code proves nothing.
      checks.persistSameCode = sameCode(meta, again.meta);
      const redeploySnap = again.ok ? await inspectPage(url, session.ns, again.meta) : null;
      checks.persistBrowser = redeploySnap !== null && browserOk(redeploySnap);
      checks.persistAssets = rotatedAssetsOk(redeploySnap, again.meta, liveAssetToken);
      if (!checks.persistBrowser || !checks.persistAssets) {
        recordBrowserFailure(out, "persist", redeploySnap);
      }
      if (checks.persistAssets) liveAssetToken = currentAssetToken(redeploySnap);
      meta = again.meta ?? meta;
      const after = again.ok ? await text(url + "api/todos") : { status: 0, body: "" };
      // The row surviving is not enough — the toggle write must survive too, or a KV-create +
      // in-memory-toggle implementation (or a faked {done:true} response) passes.
      let row = null;
      if (after.status === 200) {
        try { row = (JSON.parse(after.body).todos ?? []).find(t => t?.id === id) ?? null; } catch { /* not the contract */ }
      }
      checks.persist = row != null && row.title === "buy milk" && row.done === true;
      out.ok = Object.values(checks).every(Boolean);
      if (out.ok) {
        for (const title of VICTIM_TITLES) {
          const mk = await text(url + "api/todos", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
          });
          const vid = parseJson(mk.body)?.id ?? null;
          if (vid != null) plantedVictims.push({ id: vid, title });
        }
        checks.victimCreated = plantedVictims.length === VICTIM_TITLES.length;
        out.ok = checks.victimCreated;
      }
    }

    // A model that can only emit a working app in one shot fails here. The ask is one route, but it
    // has to land in a codebase the model already wrote and leave everything else alone — which is
    // the axis the one-shot checks above cannot see at all.
    if (out.ok) {
      const { runId: editRunId } = await postMessage(session.sessionId, INCREMENT);
      const edit = await awaitRunDone(session.sessionId, editRunId, { timeoutMs: 10 * 60_000 });
      const editTurns = assistantTurns(edit.events);
      const editCalls = toolCalls(editTurns);
      out.editTurns = editTurns.length;
      // 0 tools is the summary-instead-of-work signature; reported so it's distinguishable from
      // "deployed the wrong thing", which fails the same `redeployed` check.
      out.editTools = editCalls.length;
      // A write_file to a path this run already created is a rewrite; a path it never wrote is a
      // genuinely new file, which is a legitimate way to add a route.
      const built = new Set(writtenPaths(seq));
      out.edits = editCalls.filter(c => c.name === "edit_file").length;
      out.rewrites = writtenPaths(editCalls).filter(p => built.has(p)).length;

      const again = redeployed(edit, live);
      live = again.versionId;
      meta = again.meta ?? meta;
      checks.redeployed = again.ok;
      // The whole contract again, not just DELETE — "其余行为不要改" was part of the ask, and a
      // change that adds the route while breaking toggle is the failure mode worth catching.
      const incrProbe = again.ok ? await probeContract(url, "walk dog") : { checks: {}, id: null };
      out.regression = incrProbe.checks;
      incrRowId = incrProbe.id ?? null;
      checks.unbroken = again.ok && Object.values(incrProbe.checks).every(Boolean);

      // Only a victim confirmed on THIS side of the deploy (so, genuinely in KV) is worth deleting.
      // The model may have consumed one planted victim testing its new DELETE (legitimate — and
      // itself evidence the route works); any survivor serves. Both gone → fail, with the real
      // list in the diagnostics.
      const preDel = again.ok ? await text(url + "api/todos") : { status: 0, body: "" };
      const preRows = parseJson(preDel.body)?.todos;
      const preListed = preDel.status === 200 && Array.isArray(preRows);
      victim = preListed
        ? plantedVictims.find(v => preRows.some(t => t?.id === v.id && t?.title === v.title)) ?? null
        : null;
      checks.victimCarried = victim != null;
      // buy milk disappearing means the change destroyed existing data — which `unbroken` cannot
      // see, since it only re-probes rows it created itself. Judged on this read: it must not
      // depend on the victim flow.
      checks.survivor = preListed && preRows.some(t => t?.id === id);
      if (!checks.victimCarried || !checks.survivor) {
        out.rows = { id, plantedVictims, listed: preRows ?? preDel.body.slice(0, 200) };
      }

      // Dependent checks only exist when there is a victim to delete — stubbing them false on a
      // victimCarried failure buries the one real signal under mechanical cascade.
      if (checks.victimCarried) {
        const del = await text(url + `api/todos/${encodeURIComponent(victim.id)}`, { method: "DELETE" });
        checks.deleteRoute = del.status === 200 && parseJson(del.body)?.ok === true;

        const remaining = await text(url + "api/todos");
        const rows = parseJson(remaining.body)?.todos;
        const listed = remaining.status === 200 && Array.isArray(rows);
        // What this read cannot see is a delete that never reaches KV: it lands on the same
        // isolate, so an in-memory splice looks identical — the open round's fresh deploy closes
        // that (tombstone below).
        checks.deleted = listed && !rows.some(t => t?.id === victim.id);
        // Asserted on the POST-delete read: `survivor` above only proves the neighbours existed
        // before the DELETE — a delete that wipes the whole list would otherwise pass this round.
        checks.neighborsKept = listed
          && rows.some(t => t?.id === id && t?.title === "buy milk" && t?.done === true)
          && rows.some(t => t?.id === incrRowId && t?.title === "walk dog" && t?.done === true);
        if (!checks.deleted || !checks.neighborsKept) {
          out.rows = { id, victim, listed: rows ?? remaining.body.slice(0, 200) };
        }
      }

      // The incremental version must still serve a URL minted for its own artifact. Without the
      // token rotation check, a hard-coded URL from an earlier deploy in the same namespace passes.
      const incrSnap = again.ok ? await inspectPage(url, session.ns, meta) : null;
      checks.incrBrowser = incrSnap !== null && browserOk(incrSnap);
      checks.incrAssets = rotatedAssetsOk(incrSnap, meta, liveAssetToken);
      if (!checks.incrBrowser || !checks.incrAssets) recordBrowserFailure(out, "increment", incrSnap);
      if (checks.incrAssets) liveAssetToken = currentAssetToken(incrSnap);

      out.ok = Object.values(checks).every(Boolean);
    }

    // The open-ended round. Nothing here judges what the model built — only that it built
    // something, shipped it, and did not take the app down doing it. Deliberately a low bar:
    // models exist that clear every specified round above and still fail this one.
    if (out.ok) {
      const beforeMeta = meta;
      // Baseline for the change check. The witness now exists only in this browser's API response,
      // so using the same witnessed load on both sides adds no persistent data noise and keeps the
      // asset-observation window identical.
      const before = await inspectPage(url, session.ns, meta);
      const { runId: openRunId } = await postMessage(session.sessionId, OPEN_ENDED);
      const open = await awaitRunDone(session.sessionId, openRunId, { timeoutMs: 10 * 60_000 });
      const openCalls = toolCalls(assistantTurns(open.events));
      out.openTools = openCalls.length;
      checks.openActed = openCalls.length > 0;
      // A restyle that was never deployed is not being served; and redeployed() requires run.done,
      // so a run the product surfaced to the user as failed cannot score PASS here.
      const openDeploy = redeployed(open, live);
      live = openDeploy.versionId;
      meta = openDeploy.meta ?? meta;
      checks.openDeployed = openDeploy.ok;
      // Change = the canonical deploy artifact differs (changedCode, fails closed on missing
      // digests) AND the assets the browser actually loaded differ per manifest path. Data noise
      // is out by construction: digests cover asset bodies, not the server-rendered page.
      const after = await inspectPage(url, session.ns, meta);
      checks.openBrowser = browserOk(after);
      checks.openChanged = changedCode(beforeMeta, openDeploy.meta) && digestMapChanged(before, after);
      checks.finalAssets = rotatedAssetsOk(after, meta, liveAssetToken);
      if (!checks.openBrowser || !checks.openChanged || !checks.finalAssets) {
        recordBrowserFailure(out, "openBefore", before);
        recordBrowserFailure(out, "openAfter", after);
      }
      if (checks.finalAssets) liveAssetToken = currentAssetToken(after);
      // The cross-isolate read the incr round could not have. Taken BEFORE probeContract creates
      // anything — a length-based id scheme may legally hand the deleted id to the next create —
      // and matched on id+title so a reused id (from the model's own POSTs) can't fail it either.
      const finalList = await text(url + "api/todos");
      const finalRows = parseJson(finalList.body)?.todos;
      const finalListed = finalList.status === 200 && Array.isArray(finalRows);
      checks.tombstone = finalListed && rowIdentityAbsent(finalRows, victim.id, victim.title);
      checks.dataIntact = finalListed
        && finalRows.some(t => t?.id === id && t?.title === "buy milk" && t?.done === true);
      // A toggle that answers {done:true} without writing passes every in-isolate probe; only walk
      // dog still done:true on this side of the deploy proves the incr version's writes reach KV.
      checks.incrPersist = finalListed
        && finalRows.some(t => t?.id === incrRowId && t?.title === "walk dog" && t?.done === true);
      if (!checks.tombstone || !checks.dataIntact || !checks.incrPersist) {
        out.finalRows = finalRows ?? finalList.body.slice(0, 200);
      }
      // Re-probe the entire contract: a 502 on every request fails all of it, which is exactly
      // what shipping a broken worker and reporting 完成 looks like from outside.
      const openProbe = await probeContract(url, OPEN_WITNESS_TITLE);
      openId = openProbe.id ?? null;
      out.openSurvived = openProbe.checks;
      checks.openAlive = Object.values(openProbe.checks).every(Boolean);
      // Planted before the delete below; round 5 reads it back across one more deploy.
      const water = await text(url + "api/todos", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "water plants" }),
      });
      waterId = parseJson(water.body)?.id ?? null;
      if (waterId != null) await text(url + `api/todos/${encodeURIComponent(waterId)}/toggle`, { method: "POST" });
      checks.waterCreated = waterId != null;
      // The restyle must not cost the incr round's feature — a revert to a pre-DELETE worker keeps
      // every original check green and the tombstone intact. Receipt and effect are separate checks
      // (a stub answering {ok:true} passes the first alone); persistence is round 5's question.
      const delKept = openId == null ? { status: 0, body: "" }
        : await text(url + `api/todos/${encodeURIComponent(openId)}`, { method: "DELETE" });
      checks.deleteKept = delKept.status === 200 && parseJson(delKept.body)?.ok === true;
      const postDel = checks.deleteKept ? await text(url + "api/todos") : { status: 0, body: "" };
      const postRows = parseJson(postDel.body)?.todos;
      const postListed = postDel.status === 200 && Array.isArray(postRows);
      // Bare id absence — no create intervenes, so there is no legal reuse here, and an identity
      // match would let "rename it to deleted and answer {ok:true}" pass as a delete.
      checks.deleteApplied = postListed && !postRows.some(t => t?.id === openId);
      // Same read, collateral: the delete must not have taken neighbours with it.
      checks.deleteScoped = postListed
        && postRows.some(t => t?.id === id && t?.title === "buy milk" && t?.done === true)
        && postRows.some(t => t?.id === incrRowId && t?.title === "walk dog" && t?.done === true);
      out.ok = Object.values(checks).every(Boolean);
    }

    // Round 5 — one more plain redeploy: every mutation the open round exercised happened inside
    // one isolate, so a final version that writes only to memory passes everything above.
    if (out.ok) {
      const { runId: lastRunId } = await postMessage(session.sessionId, REDEPLOY);
      const lastRun = await awaitRunDone(session.sessionId, lastRunId, { timeoutMs: 5 * 60_000 });
      const lastDeploy = redeployed(lastRun, live);
      live = lastDeploy.versionId;
      checks.finalRedeployed = lastDeploy.ok;
      // Without this, the round proves nothing about round 4's code: a model that deploys a
      // read-only stub here would still show the planted rows.
      checks.finalSameCode = sameCode(meta, lastDeploy.meta);
      const finalSnap = lastDeploy.ok ? await inspectPage(url, session.ns, lastDeploy.meta) : null;
      checks.finalDeployBrowser = finalSnap !== null && browserOk(finalSnap);
      checks.finalDeployAssets = rotatedAssetsOk(finalSnap, lastDeploy.meta, liveAssetToken);
      if (!checks.finalDeployBrowser || !checks.finalDeployAssets) {
        recordBrowserFailure(out, "finalDeploy", finalSnap);
      }
      if (checks.finalDeployAssets) liveAssetToken = currentAssetToken(finalSnap);
      const lastList = lastDeploy.ok ? await text(url + "api/todos") : { status: 0, body: "" };
      const lastRows = parseJson(lastList.body)?.todos;
      const lastListed = lastList.status === 200 && Array.isArray(lastRows);
      checks.openWritePersist = lastListed
        && lastRows.some(t => t?.id === waterId && t?.title === "water plants" && t?.done === true);
      // The model re-verifies side-effecting routes during the final deploy and may create a temporary
      // row before this read. A length-based allocator can legally reuse feed cat's deleted id, so
      // match the witness identity rather than treating any reused id as resurrection.
      checks.openDeletePersist = lastListed && rowIdentityAbsent(lastRows, openId, OPEN_WITNESS_TITLE);
      checks.finalIntact = lastListed
        && lastRows.some(t => t?.id === id && t?.title === "buy milk" && t?.done === true)
        && lastRows.some(t => t?.id === incrRowId && t?.title === "walk dog" && t?.done === true);
      if (!checks.openWritePersist || !checks.openDeletePersist || !checks.finalIntact) {
        out.finalRows5 = lastRows ?? lastList.body.slice(0, 200);
      }
      // Behavioral re-verification on the final version: the list read above only proves it can
      // READ old KV — every route must still work. Persistence of these last mutations rests on
      // finalSameCode + the round-4 witnesses, which is where the regress bottoms out.
      const { checks: finalProbe, id: lastId } = await probeContract(url, "mow lawn");
      out.finalProbe = finalProbe;
      checks.finalAlive = Object.values(finalProbe).every(Boolean);
      const lastDel = lastId == null ? { status: 0, body: "" }
        : await text(url + `api/todos/${encodeURIComponent(lastId)}`, { method: "DELETE" });
      checks.finalDeleteKept = lastDel.status === 200 && parseJson(lastDel.body)?.ok === true;
      const lastPost = checks.finalDeleteKept ? await text(url + "api/todos") : { status: 0, body: "" };
      const lastPostRows = parseJson(lastPost.body)?.todos;
      checks.finalDeleteApplied = lastPost.status === 200 && Array.isArray(lastPostRows)
        && !lastPostRows.some(t => t?.id === lastId);
      out.ok = Object.values(checks).every(Boolean);
    }

    if (!out.ok) out.fail = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(",");
    return out;
  } catch (err) {
    // ok is true by the time the later rounds run — without the reset, a throw mid-round scores
    // PASS on rounds that never happened.
    out.ok = false;
    out.fail = err.message.slice(0, 140);
    return out;
  } finally {
    // finally mutates the object every return path hands back, so one stamp covers them all.
    out.sec = +((Date.now() - t0) / 1000).toFixed(1);
    if (session) await closeSession(session.sessionId).catch(() => {});
  }
}

if (!HAS_E2E_BASE) {
  console.error("WDL_CHAT_BASE_URL is not set — see the header for usage.");
  process.exit(2);
}

judge = await createBrowserJudge({ assetsHost: ASSETS_HOST });

const runs = Math.max(1, Number(process.argv[2]) || 1);
const label = process.argv[3] ?? "run";
console.error(`# ${BASE} — ${runs} run(s), each holds a tmp ns for 6h`);

const results = [];
for (let i = 1; i <= runs; i++) {
  const r = await runOnce(`${label}#${i}`);
  results.push(r);
  const mark = r.ok ? "PASS" : "FAIL";
  const inc = r.edits == null ? "" : ` incr(tools=${r.editTools} edits=${r.edits} rewrites=${r.rewrites})`
    + (r.openTools == null ? "" : ` open(tools=${r.openTools})`);
  console.log(`${mark} ${r.label.padEnd(14)} ${String(r.sec).padStart(6)}s  turns=${r.turns ?? "-"} tools=${r.tools ?? "-"} deploys=${r.deploys ?? "-"}${inc}  ${r.ok ? "" : `← ${r.fail}`}`);
  // The full record (ns, per-check booleans, probe counts) — diagnosing a FAIL needs it, and the ns
  // is the handle for finding the session afterwards.
  if (!r.ok) console.error(`# ${JSON.stringify(r)}`);
}

const passed = results.filter(r => r.ok).length;
const timed = results.filter(r => typeof r.sec === "number");
const avg = timed.length ? (timed.reduce((n, r) => n + r.sec, 0) / timed.length).toFixed(1) : "-";
console.log(`\n${passed}/${results.length} passed, avg ${avg}s`);

// Not a pass/fail axis — a model that rewrites the file still ships a working DELETE. It is the
// number to read when deciding whether edit_file is reaching the models at all.
const reached = results.filter(r => r.edits != null);
if (reached.length) {
  console.log(`incremental round: ${reached.length} reached, `
    + `${reached.filter(r => r.editTools === 0).length} did nothing at all, `
    + `${reached.filter(r => r.edits > 0).length} used edit_file, `
    + `${reached.filter(r => r.rewrites > 0).length} rewrote a file whole`);
}
await judge.close();
process.exit(passed === results.length ? 0 : 1);

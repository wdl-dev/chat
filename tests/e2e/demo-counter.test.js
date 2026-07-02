import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE,
  HAS_E2E_BASE,
  awaitRunDone,
  closeSession,
  createSession,
  postMessage,
} from "./_helpers.js";

test("demo 2: AI builds a KV-backed counter with bug-fix loop", { skip: !HAS_E2E_BASE }, async () => {
  console.error(`# WDL_CHAT_BASE_URL=${BASE}`);
  const session = await createSession();
  console.error(`# session=${session.sessionId} ns=${session.ns}`);

  try {
    const prompt =
      "写一个 KV demo：GET /increment 让 counter 加 1 后返回 { count: <new> }，GET /value 返回当前值。\n" +
      "参考 examples/kv-demo。完整流程：wdl init / 编辑 wrangler.jsonc 加 [[kv_namespaces]] / 编辑 src / deploy_test。\n" +
      "如果 call_preview 报错或行为不对，用 tail_logs 查 30 秒错误日志，修代码再 deploy_test。\n" +
      "完成标准：连续 call_preview /increment 三次，返回的 count 严格递增；call_preview /value 等于最后一次 increment 的 count。";
    const t0 = Date.now();
    const { runId } = await postMessage(session.sessionId, prompt);
    const { terminal, preview, assistantText } = await awaitRunDone(session.sessionId, runId, {
      timeoutMs: 8 * 60_000,
    });
    const dur = (Date.now() - t0) / 1000;
    console.error(`# run.${terminal.event.split(".")[1]} after ${dur.toFixed(1)}s; assistant text length ${assistantText.length}`);

    assert.equal(terminal.event, "run.done", `expected run.done, got ${terminal.event}: ${JSON.stringify(terminal.data).slice(0, 400)}`);
    assert.ok(preview?.previewUrl, `expected preview.ready event with previewUrl; assistantText:\n${assistantText.slice(0, 1000)}`);

    // Three calls to /increment should produce strictly increasing counts.
    const counts = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${preview.previewUrl}increment`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(typeof body.count === "number", `expected numeric count, got ${JSON.stringify(body)}`);
      counts.push(body.count);
    }
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] > counts[i - 1], `count must strictly increase: ${counts.join(", ")}`);
    }

    const r = await fetch(`${preview.previewUrl}value`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.count, counts[counts.length - 1]);
  } finally {
    await closeSession(session.sessionId);
  }
});

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

test("demo 1: AI scaffolds + deploys + verifies a {hello: 'world'} worker", { skip: !HAS_E2E_BASE }, async () => {
  console.error(`# WDL_CHAT_BASE_URL=${BASE}`);
  const session = await createSession();
  console.error(`# session=${session.sessionId} ns=${session.ns}`);

  try {
    const prompt =
      "写一个返回 JSON {hello: 'world'} 的 worker。\n" +
      "完整流程：wdl init / 编辑 src/index.js / dry-run / deploy_test / call_preview / 报告完成。\n" +
      "要求 call_preview / 收到 200 + body.hello === 'world' 才算成功。";
    const t0 = Date.now();
    const { runId } = await postMessage(session.sessionId, prompt);
    const { terminal, preview, assistantText } = await awaitRunDone(session.sessionId, runId);
    const dur = (Date.now() - t0) / 1000;
    console.error(`# run.${terminal.event.split(".")[1]} after ${dur.toFixed(1)}s; assistant text length ${assistantText.length}`);

    assert.equal(terminal.event, "run.done", `expected run.done, got ${terminal.event}: ${JSON.stringify(terminal.data).slice(0, 400)}`);
    assert.ok(preview?.previewUrl, `expected preview.ready event with previewUrl; assistantText:\n${assistantText.slice(0, 1000)}`);

    const r = await fetch(preview.previewUrl);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { hello: "world" });
  } finally {
    await closeSession(session.sessionId);
  }
});

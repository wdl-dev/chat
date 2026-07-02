import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody, callLlmMessages, resolveLlmConfig, pickModel } from "../src/llm.js";

test("buildRequestBody composes minimal body", () => {
  const body = buildRequestBody({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.max_tokens, 16384);
  assert.equal(body.system, undefined);
  assert.equal(body.tools, undefined);
});

test("resolveLlmConfig falls through to defaults on empty / missing env", () => {
  for (const env of [undefined, null, {}]) {
    const cfg = resolveLlmConfig(env);
    assert.equal(cfg.model, "deepseek-v4-pro");
    assert.equal(cfg.baseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(cfg.maxTokens, 16384);
    assert.equal(cfg.budgetMs, 180_000);
  }
});

test("resolveLlmConfig honours overrides", () => {
  const cfg = resolveLlmConfig({
    LLM_MODEL: "deepseek-v4-flash",
    LLM_MODEL_LITE: "deepseek-v4-tiny",
    LLM_BASE_URL: "https://example.test/anthropic",
    LLM_MAX_TOKENS: "8192",
    LLM_BUDGET_MS: "240000",
  });
  assert.equal(cfg.model, "deepseek-v4-flash");
  assert.equal(cfg.modelLite, "deepseek-v4-tiny");
  assert.equal(cfg.baseUrl, "https://example.test/anthropic");
  assert.equal(cfg.maxTokens, 8192);
  assert.equal(cfg.budgetMs, 240000);
});

test("pickModel returns primary on intent-bearing user text", () => {
  const cfg = { model: "pro", modelLite: "flash" };
  assert.equal(
    pickModel([
      { role: "user", content: [{ type: "text", text: "做一个网页" }] },
    ], cfg),
    "pro",
  );
  assert.equal(
    pickModel([{ role: "user", content: "继续" }], cfg),
    "pro",
  );
});

test("pickModel returns lite for tool_result-only continuation", () => {
  const cfg = { model: "pro", modelLite: "flash" };
  assert.equal(
    pickModel([
      { role: "user", content: [{ type: "text", text: "做个页面" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ], cfg),
    "flash",
  );
});

test("pickModel handles mixed tool_result + text by going primary", () => {
  const cfg = { model: "pro", modelLite: "flash" };
  assert.equal(
    pickModel([
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "{}" },
        { type: "text", text: "其实重新做" },
      ] },
    ], cfg),
    "pro",
  );
});

test("pickModel falls back to primary on empty / non-user last message", () => {
  const cfg = { model: "pro", modelLite: "flash" };
  assert.equal(pickModel([], cfg), "pro");
  assert.equal(pickModel(undefined, cfg), "pro");
  assert.equal(pickModel([{ role: "assistant", content: [] }], cfg), "pro");
});

test("resolveLlmConfig rejects non-positive / NaN / empty-string ints, falls through", () => {
  for (const bad of ["", "0", "-100", "abc", "12.5", null, undefined]) {
    const cfg = resolveLlmConfig({ LLM_MAX_TOKENS: bad, LLM_BUDGET_MS: bad });
    assert.equal(cfg.maxTokens, 16384);
    assert.equal(cfg.budgetMs, 180_000);
  }
});

test("resolveLlmConfig rejects empty / non-string overrides for model + baseUrl", () => {
  for (const bad of ["", null, undefined, 0, false]) {
    const cfg = resolveLlmConfig({ LLM_MODEL: bad, LLM_BASE_URL: bad });
    assert.equal(cfg.model, "deepseek-v4-pro");
    assert.equal(cfg.baseUrl, "https://api.deepseek.com/anthropic");
  }
});

function streamFromString(text) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { c.enqueue(enc.encode(text)); c.close(); },
  });
}

function streamFromChunks(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

const SSE_FIXTURE_LINES = [
  ["event: message_start", 'data: {"type":"message_start","message":{"id":"m1","role":"assistant","model":"deepseek-v4-pro"}}'],
  ["event: content_block_start", 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'],
  ["event: content_block_delta", 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}'],
  ["event: content_block_delta", 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}'],
  ["event: content_block_stop", 'data: {"type":"content_block_stop","index":0}'],
  ["event: message_delta", 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}'],
  ["event: message_stop", 'data: {"type":"message_stop"}'],
];

function buildSseFixture(sep) {
  return SSE_FIXTURE_LINES.map(lines => lines.join(sep)).join(sep + sep) + sep + sep;
}

async function callWithFakeStream(streamText, onDelta) {
  const fakeRes = {
    ok: true,
    status: 200,
    body: streamFromString(streamText),
  };
  return await callLlmMessages({
    env: { LLM_API_KEY: "k" },
    messages: [{ role: "user", content: "hi" }],
    fetcher: async () => fakeRes,
    onDelta,
  });
}

test("streaming consumer assembles text + stop_reason from LF-separated SSE", async () => {
  const deltas = [];
  const resp = await callWithFakeStream(buildSseFixture("\n"), (e) => deltas.push(e));
  assert.equal(resp.content.length, 1);
  assert.equal(resp.content[0].type, "text");
  assert.equal(resp.content[0].text, "hi there");
  assert.equal(resp.stop_reason, "end_turn");
  assert.equal(resp.usage?.output_tokens, 2);
  // Expect: 2 text_delta + 1 message_complete = 3
  const types = deltas.map(d => d.type);
  assert.deepEqual(types.filter(t => t === "text_delta").length, 2);
  assert.ok(types.includes("message_complete"));
});

test("streaming consumer normalizes CRLF separators (proxy-injected)", async () => {
  const deltas = [];
  const resp = await callWithFakeStream(buildSseFixture("\r\n"), (e) => deltas.push(e));
  assert.equal(resp.content.length, 1);
  assert.equal(resp.content[0].text, "hi there");
  assert.equal(resp.stop_reason, "end_turn");
  assert.ok(deltas.length >= 3);
});

test("streaming consumer redacts upstream error fields (no prompt/context echo)", async () => {
  const sse = [
    ["event: message_start", 'data: {"type":"message_start","message":{"id":"m1","role":"assistant"}}'],
    ["event: error", 'data: {"type":"error","error":{"type":"SECRET_TYPE_LEAK","message":"SECRET_PROMPT_ECHO"}}'],
  ].map(parts => parts.join("\n")).join("\n\n") + "\n\n";
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    await assert.rejects(
      callWithFakeStream(sse, () => {}),
      (e) => {
        assert.equal(e.message, "LLM stream error"); // fixed text — never the upstream type/message
        return true;
      },
    );
  } finally {
    console.warn = origWarn;
  }
  // neither the thrown error nor any server log may carry the upstream fields
  assert.ok(!warns.some(w => /SECRET/.test(w)), `server log leaked upstream field: ${warns.join(" | ")}`);
});

test("streaming consumer handles chunk boundary between \\r and \\n", async () => {
  // Split a CRLF fixture between \r and \n so per-chunk normalization
  // would leave it intact; only whole-buffer normalization catches it.
  const full = buildSseFixture("\r\n");
  const crIdx = full.indexOf("\r\n");
  assert.ok(crIdx > 0, "fixture must contain CRLF");
  const c1 = full.slice(0, crIdx + 1);
  const c2 = full.slice(crIdx + 1);
  const fakeRes = {
    ok: true, status: 200,
    body: streamFromChunks([c1, c2]),
  };
  const deltas = [];
  const resp = await callLlmMessages({
    env: { LLM_API_KEY: "k" },
    messages: [{ role: "user", content: "hi" }],
    fetcher: async () => fakeRes,
    onDelta: (e) => deltas.push(e),
  });
  assert.equal(resp.content.length, 1);
  assert.equal(resp.content[0].text, "hi there");
  assert.equal(resp.stop_reason, "end_turn");
  assert.ok(deltas.length >= 3);
});

test("streaming consumer assembles tool_use input from input_json_delta chunks", async () => {
  const sse = [
    ["event: message_start", 'data: {"type":"message_start","message":{"id":"m1","role":"assistant"}}'],
    ["event: content_block_start", 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"write_file","input":{}}}'],
    ["event: content_block_delta", 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}'],
    ["event: content_block_delta", 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"x.js\\"}"}}'],
    ["event: content_block_stop", 'data: {"type":"content_block_stop","index":0}'],
    ["event: message_delta", 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}'],
    ["event: message_stop", 'data: {"type":"message_stop"}'],
  ].map(parts => parts.join("\n")).join("\n\n") + "\n\n";
  const deltas = [];
  const resp = await callWithFakeStream(sse, (e) => deltas.push(e));
  assert.equal(resp.content.length, 1);
  assert.equal(resp.content[0].type, "tool_use");
  assert.equal(resp.content[0].name, "write_file");
  assert.deepEqual(resp.content[0].input, { path: "x.js" });
  assert.equal(resp.stop_reason, "tool_use");
  assert.ok(deltas.some(d => d.type === "tool_use_complete" && d.name === "write_file"));
});

test("buildRequestBody includes optional fields when set", () => {
  const body = buildRequestBody({
    system: "be helpful",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "x", input_schema: { type: "object" } }],
    maxTokens: 200,
    model: "deepseek-v4-flash",
  });
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.max_tokens, 200);
  assert.equal(body.system, "be helpful");
  assert.deepEqual(body.tools, [{ name: "x", input_schema: { type: "object" } }]);
});

test("buildRequestBody drops empty tools array", () => {
  const body = buildRequestBody({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  assert.equal(body.tools, undefined);
});

test("callLlmMessages throws when LLM_API_KEY missing", async () => {
  await assert.rejects(
    () => callLlmMessages({ env: {}, messages: [], fetcher: async () => null }),
    /LLM_API_KEY not configured/,
  );
});

test("callLlmMessages POSTs to {baseURL}/v1/messages with x-api-key", async () => {
  const calls = [];
  const fakeRes = {
    ok: true,
    async json() { return { id: "m1", role: "assistant", stop_reason: "end_turn", content: [] }; },
  };
  await callLlmMessages({
    env: { LLM_API_KEY: "sk-test" },
    messages: [{ role: "user", content: "hi" }],
    system: "you are helpful",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return fakeRes;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-api-key"], "sk-test");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.system, "you are helpful");
});

test("callLlmMessages: an explicit model overrides pickModel (plan reasoning-model contract)", async () => {
  let body;
  const fakeRes = { ok: true, async json() { return { id: "m", role: "assistant", stop_reason: "end_turn", content: [] }; } };
  await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_MODEL: "pro", LLM_MODEL_LITE: "flash" },
    // A tool_result-only tail would make pickModel choose the lite model...
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }],
    model: "pro", // ...but an explicit model must win — this is what the plan path now relies on.
    fetcher: async (_url, init) => { body = JSON.parse(init.body); return fakeRes; },
  });
  assert.equal(body.model, "pro");
});

test("callLlmMessages honours LLM_BASE_URL / LLM_MODEL overrides", async () => {
  let captured;
  await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_BASE_URL: "https://example.test/anthropic", LLM_MODEL: "deepseek-v4-flash" },
    messages: [{ role: "user", content: "hi" }],
    fetcher: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, async json() { return {}; } };
    },
  });
  assert.equal(captured.url, "https://example.test/anthropic/v1/messages");
  assert.equal(captured.body.model, "deepseek-v4-flash");
});

test("callLlmMessages throws structured error on non-2xx", async () => {
  const fakeRes = {
    ok: false,
    status: 429,
    async text() { return '{"error":"rate limited"}'; },
  };
  await assert.rejects(
    () => callLlmMessages({
      env: { LLM_API_KEY: "k" },
      messages: [{ role: "user", content: "hi" }],
      fetcher: async () => fakeRes,
      maxAttempts: 1,
    }),
    /LLM HTTP 429/,
  );
});

test("callLlmMessages retries transient 5xx then succeeds", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, async text() { return "busy"; } };
    return { ok: true, status: 200, async json() { return { content: [{ type: "text", text: "ok" }] }; } };
  };
  const resp = await callLlmMessages({
    env: { LLM_API_KEY: "k" },
    messages: [{ role: "user", content: "hi" }],
    fetcher,
    sleep: async () => {},          // instant backoff for the test
  });
  assert.equal(calls, 3);
  assert.equal(resp.content[0].text, "ok");
});

test("callLlmMessages stops retrying once attempts exhaust", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: false, status: 500, async text() { return "boom"; } }; };
  await assert.rejects(
    () => callLlmMessages({
      env: { LLM_API_KEY: "k" },
      messages: [{ role: "user", content: "hi" }],
      fetcher,
      sleep: async () => {},
    }),
    /LLM HTTP 500/,
  );
  assert.equal(calls, 3);
});

test("callLlmMessages retries a thrown network error then succeeds", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls < 3) throw new Error("ECONNRESET");
    return { ok: true, status: 200, async json() { return { content: [{ type: "text", text: "ok" }] }; } };
  };
  const resp = await callLlmMessages({
    env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher, sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(resp.content[0].text, "ok");
});

test("callLlmMessages rethrows a network error once attempts exhaust", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("ECONNRESET"); };
  await assert.rejects(
    () => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher, sleep: async () => {} }),
    /ECONNRESET/,
  );
  assert.equal(calls, 3);
});

test("callLlmMessages does not retry a network error when already aborted", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("ECONNRESET"); };
  await assert.rejects(
    () => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher, sleep: async () => {}, signal: AbortSignal.abort() }),
    /ECONNRESET/,
  );
  assert.equal(calls, 1);
});

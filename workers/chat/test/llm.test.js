import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody, callLlmMessages, resolveLlmConfig, pickModel } from "../src/llm.js";
import { streamFromChunks, streamFromString, streamThenError } from "./_stream.js";

test("buildRequestBody composes minimal body", () => {
  const body = buildRequestBody({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.max_tokens, 16384);
  assert.equal(body.system, undefined);
  assert.equal(body.tools, undefined);
});

test("buildRequestBody passes thinking through untouched, signed or not", () => {
  // Kimi's Anthropic endpoint never signs; dropping unsigned thinking would strip its whole
  // reasoning history, the silent degradation CLAUDE.md forbids.
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "unsigned", signature: "" }] },
  ];
  assert.equal(buildRequestBody({ messages }).messages, messages);
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
    LLM_MODEL: "qwen3.7-max",
    LLM_MODEL_LITE: "qwen3.7-flash",
    LLM_BASE_URL: "https://example.test/anthropic",
    LLM_MAX_TOKENS: "8192",
    LLM_BUDGET_MS: "240000",
  });
  assert.equal(cfg.model, "qwen3.7-max");
  assert.equal(cfg.modelLite, "qwen3.7-flash");
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

test("a max_tokens turn carrying a complete tool_use is accepted, not rejected as inconsistent", async () => {
  // The cap can land right after a tool_use block closes. That is a legitimate provider response:
  // the run-loop ends the turn without dispatching, and _buildLlmMessages heals the missing result.
  const anth = { ok: true, status: 200, async json() {
    return { id: "m", role: "assistant", stop_reason: "max_tokens", content: [
      { type: "text", text: "writing the file" },
      { type: "tool_use", id: "t1", name: "write_file", input: { path: "/workspace/a.js" } },
    ] };
  } };
  const r = await callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => anth });
  assert.equal(r.stop_reason, "max_tokens");
  assert.equal(r.content.filter(b => b.type === "tool_use").length, 1);
});

test("blank thinking / whitespace text / redacted-only responses count as no displayable content", async () => {
  const bodies = [
    { label: "empty thinking", content: [{ type: "thinking", thinking: "" }] },
    { label: "whitespace text", content: [{ type: "text", text: "   \n" }] },
    { label: "redacted only", content: [{ type: "redacted_thinking", data: "xx" }] },
  ];
  for (const { label, content } of bodies) {
    const res = { ok: true, status: 200, async json() { return { id: "m", role: "assistant", stop_reason: "end_turn", content }; } };
    await assert.rejects(
      () => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => res }),
      /no displayable content/,
      label,
    );
  }
  // non-blank thinking alone IS renderable (the UI shows a thinking block)
  const ok = { ok: true, status: 200, async json() { return { id: "m", role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "reasoning" }] }; } };
  const out = await callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => ok });
  assert.equal(out.stop_reason, "end_turn");
});

test("an empty assistant response (no displayable content) is rejected, not recorded as a done turn", async () => {
  // Anthropic shape: end_turn with content: [].
  const anth = { ok: true, status: 200, async json() { return { id: "m", role: "assistant", stop_reason: "end_turn", content: [] }; } };
  await assert.rejects(() => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => anth }), /no displayable content/);
  // OpenAI shape: stop, no content, no tool_calls.
  const oai = { ok: true, status: 200, async json() { return { id: "m", model: "x", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] }; } };
  await assert.rejects(() => callLlmMessages({ env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => oai }), /no displayable content/);
});

test("streaming consumer returns on message_stop without waiting for the body to close", async () => {
  const enc = new TextEncoder();
  const full = buildSseFixture("\n");   // includes the trailing message_stop
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode(full)); /* deliberately never close() */ } });
  const done = callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], onDelta: () => {}, fetcher: async () => ({ ok: true, status: 200, body }) });
  let timer;
  const race = await Promise.race([done.then(r => ({ r })), new Promise(res => { timer = setTimeout(() => res("TIMEOUT"), 1000); })]);
  clearTimeout(timer);
  assert.notEqual(race, "TIMEOUT", "must stop at message_stop, not hang until HTTP EOF / the budget");
  assert.equal(race.r.stop_reason, "end_turn");
});

test("streaming consumer requires message_stop — a stream that ends at message_delta throws", async () => {
  // Full fixture minus the trailing message_stop: has stop_reason but the transport was cut short.
  const noStop = SSE_FIXTURE_LINES.slice(0, -1).map(lines => lines.join("\n")).join("\n\n") + "\n\n";
  await assert.rejects(callWithFakeStream(noStop, () => {}), /did not complete/);
});

test("non-streaming response with a null stop_reason is rejected (both shapes), not saved as a half turn", async () => {
  // Anthropic shape: raw body missing stop_reason.
  const anth = { ok: true, status: 200, async json() { return { id: "m", role: "assistant", content: [{ type: "text", text: "half" }], stop_reason: null }; } };
  await assert.rejects(() => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => anth }), /missing a valid stop_reason/);
  // OpenAI shape: finish_reason null.
  const oai = { ok: true, status: 200, async json() { return { id: "m", model: "x", choices: [{ finish_reason: null, message: { role: "assistant", content: "half" } }] }; } };
  await assert.rejects(() => callLlmMessages({ env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => oai }), /missing a valid stop_reason/);
  // Empty-string stop_reason must also be rejected (finish_reason:"" passes a null-only check).
  const empty = { ok: true, status: 200, async json() { return { id: "m", role: "assistant", content: [{ type: "text", text: "half" }], stop_reason: "" }; } };
  await assert.rejects(() => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => empty }), /missing a valid stop_reason/);
});

test("non-streaming parse error throws a fixed message — never echoes the upstream body", async () => {
  const badBody = 'SECRET_PROMPT_ECHO {not json';
  const fakeRes = { ok: true, status: 200, async json() { throw new SyntaxError(`Unexpected token in ${badBody}`); } };
  await assert.rejects(
    () => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => fakeRes }),
    (err) => {
      assert.equal(err.message, "LLM response: malformed JSON body");
      assert.ok(!err.message.includes("SECRET_PROMPT_ECHO"), "must not leak the upstream body");
      return true;
    },
  );
});

test("an unknown delta type that collides with an Object prototype key stays ignorable", async () => {
  const build = (lines) => lines.map(p => p.join("\n")).join("\n\n") + "\n\n";
  const sse = build([
    ["event: message_start", 'data: {"type":"message_start","message":{"id":"m1","role":"assistant"}}'],
    ["event: content_block_start", 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'],
    ["event: content_block_delta", 'data: {"type":"content_block_delta","index":0,"delta":{"type":"constructor"}}'],
    ["event: content_block_delta", 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}'],
    ["event: content_block_stop", 'data: {"type":"content_block_stop","index":0}'],
    ["event: message_delta", 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}'],
    ["event: message_stop", 'data: {"type":"message_stop"}'],
  ]);
  const out = await callWithFakeStream(sse, () => {});
  assert.equal(out.content[0].text, "hi");
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
    model: "grok-4.5",
  });
  assert.equal(body.model, "grok-4.5");
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
    async json() { return { id: "m1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; },
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
  // Anthropic shape sends x-api-key only — a stray Authorization 401s some endpoints.
  assert.equal(calls[0].init.headers["authorization"], undefined);
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.system, "you are helpful");
  assert.equal(body.reasoning_effort, undefined);
});

test("LLM_REASONING_EFFORT flows into the Anthropic body as output_config.effort (not top-level)", async () => {
  let body;
  const fakeRes = { ok: true, async json() { return { id: "m", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } };
  await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_REASONING_EFFORT: "low" },
    messages: [{ role: "user", content: "hi" }],
    fetcher: async (url, init) => { body = JSON.parse(init.body); return fakeRes; },
  });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.reasoning_effort, undefined);
});

test("callLlmMessages: an explicit model overrides pickModel (plan reasoning-model contract)", async () => {
  let body;
  const fakeRes = { ok: true, async json() { return { id: "m", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } };
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
    env: { LLM_API_KEY: "k", LLM_BASE_URL: "https://example.test/anthropic", LLM_MODEL: "grok-4.5" },
    messages: [{ role: "user", content: "hi" }],
    fetcher: async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } };
    },
  });
  assert.equal(captured.url, "https://example.test/anthropic/v1/messages");
  assert.equal(captured.body.model, "grok-4.5");
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
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } };
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
    return { ok: true, status: 200, async json() { return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] }; } };
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

const CUT_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n'
  + 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n'
  + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"writing it"}}\n\n'
  + 'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"t1","name":"write_file","input":{}}}\n\n'
  + 'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/a\\"}"}}\n\n'
  + 'event: content_block_stop\ndata: {"index":1}\n\n'
  + 'event: content_block_start\ndata: {"index":2,"content_block":{"type":"tool_use","id":"t2","name":"write_file","input":{}}}\n\n'
  + 'event: content_block_delta\ndata: {"index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/b\\",\\"content\\":\\"half"}}\n\n';

test("a cut-short Anthropic turn is salvaged: finished tool call kept, half-streamed one dropped", async () => {
  const signal = { aborted: true, reason: "llm_timeout" };
  const r = await callLlmMessages({
    env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], onDelta: () => {}, signal,
    salvageOnAbort: (reason) => reason === "llm_timeout",
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(CUT_SSE) }),
  });
  assert.equal(r.salvaged, true);
  // stop_reason becomes tool_use so the run loop dispatches what survived instead of ending the run.
  assert.equal(r.stop_reason, "tool_use");
  assert.deepEqual(r.content.map(b => b.type), ["text", "tool_use"]);
  assert.deepEqual(r.content[1].input, { path: "/a" });
});

test("salvage only applies to the abort reason the caller opted into", async () => {
  const signal = { aborted: true, reason: "stopped" };
  await assert.rejects(() => callLlmMessages({
    env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], onDelta: () => {}, signal,
    salvageOnAbort: (reason) => reason === "llm_timeout",
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(CUT_SSE) }),
  }));
  // and with no predicate at all it still throws
  await assert.rejects(() => callLlmMessages({
    env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], onDelta: () => {},
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(CUT_SSE) }),
  }));
});

test("a cut-short turn with nothing usable is not salvaged", async () => {
  const thinkingOnly =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n'
    + 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n'
    + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"still reasoning"}}\n\n';
  await assert.rejects(() => callLlmMessages({
    env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], onDelta: () => {},
    signal: { aborted: true, reason: "llm_timeout" }, salvageOnAbort: () => true,
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(thinkingOnly) }),
  }));
});

test("a tool call cut before any argument bytes is dropped, placeholder input notwithstanding", async () => {
  // The wire's content_block_start carries input:{} — it must not make an unopened call look closed.
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n'
    + 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"deploying"}}\n\n'
    + 'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"t1","name":"deploy_test","input":{}}}\n\n';
  const r = await callLlmMessages({
    env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], onDelta: () => {},
    signal: { aborted: true, reason: "llm_timeout" }, salvageOnAbort: () => true,
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(sse) }),
  });
  // {} is a VALID input for deploy_test (required: []), so keeping it would deploy a half-edited
  // workspace. Only the text survives; the run ends as a max_tokens truncation.
  assert.deepEqual(r.content.map(b => b.type), ["text"]);
  assert.equal(r.stop_reason, "max_tokens");
});

test("resolveLlmConfig rejects an unknown LLM_MAX_TOKENS_PARAM instead of passing it through", () => {
  // Chat Completions accepts unknown cap fields silently, so a typo'd field would leave the cap
  // unenforced with nothing to diagnose.
  assert.throws(() => resolveLlmConfig({ LLM_MAX_TOKENS_PARAM: "max_output_tokens" }), /LLM_MAX_TOKENS_PARAM/);
  assert.equal(resolveLlmConfig({ LLM_MAX_TOKENS_PARAM: "max_completion_tokens" }).maxTokensParam, "max_completion_tokens");
  assert.equal(resolveLlmConfig({}).maxTokensParam, "max_tokens");
});

test("a corrupted frame on a handled event skips, costing its delta but not the turn", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n'
    + 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"he"}}\n\n'
    + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","tex\n\n'
    + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"llo"}}\n\n'
    + 'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n'
    + 'event: message_stop\ndata: {}\n\n';
  const r = await callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }],
    onDelta: () => {}, fetcher: async () => ({ ok: true, status: 200, body: streamFromString(sse) }) });
  assert.equal(r.content[0].text, "hello");
  assert.equal(r.stop_reason, "end_turn");
});

test("a message_stop with a garbage payload still terminates the turn", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n'
    + 'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n'
    + 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"done"}}\n\n'
    + 'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n'
    + 'event: message_stop\ndata: not json\n\n';
  const r = await callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }],
    onDelta: () => {}, fetcher: async () => ({ ok: true, status: 200, body: streamFromString(sse) }) });
  assert.equal(r.stop_reason, "end_turn");
  assert.equal(r.content[0].text, "done");
});

test("a 200-status error body is a provider failure, not an empty model reply", async () => {
  const res = { ok: true, status: 200, async json() { return { error: { message: "quota" } }; } };
  await assert.rejects(
    () => callLlmMessages({ env: { LLM_API_KEY: "k" }, messages: [{ role: "user", content: "hi" }], fetcher: async () => res }),
    /provider returned an error/);
});

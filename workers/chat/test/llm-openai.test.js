import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeOpenAiStream, fromOpenAiResponse, toOpenAiBody } from "../src/llm-openai.js";
import { callLlmMessages, resolveLlmConfig } from "../src/llm.js";
import { streamFromChunks, streamFromString, streamThenError } from "./_stream.js";

test("toOpenAiBody: system + string content pass through", () => {
  const body = toOpenAiBody({
    system: "be helpful",
    messages: [{ role: "user", content: "hi" }],
    model: "deepseek-v4-pro",
    maxTokens: 100,
  });
  assert.deepEqual(body.messages, [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.max_tokens, 100);   // default field — DeepSeek honors it, ignores max_completion_tokens
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test("toOpenAiBody: assistant thinking/text/tool_use map to reasoning_content/content/tool_calls", () => {
  const body = toOpenAiBody({
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "need the file" },
        { type: "text", text: "reading it" },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } },
      ],
    }],
    model: "m", maxTokens: 1,
  });
  assert.deepEqual(body.messages, [{
    role: "assistant",
    content: "reading it",
    reasoning_content: "need the file",
    tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } }],
  }]);
});

test("toOpenAiBody: user tool_results become role:tool messages before user text", () => {
  const body = toOpenAiBody({
    messages: [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "out1", is_error: false },
        { type: "tool_result", tool_use_id: "t2", content: "out2", is_error: true },
        { type: "text", text: "接着做" },
      ],
    }],
    model: "m", maxTokens: 1,
  });
  assert.deepEqual(body.messages, [
    { role: "tool", tool_call_id: "t1", content: "out1" },
    { role: "tool", tool_call_id: "t2", content: "out2" },
    { role: "user", content: "接着做" },
  ]);
});

test("toOpenAiBody: tools convert to function wrappers; reasoning_effort included when set", () => {
  const body = toOpenAiBody({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "x", description: "d", input_schema: { type: "object" } }],
    reasoningEffort: "low",
    model: "m", maxTokens: 1,
  });
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "x", description: "d", parameters: { type: "object" } } },
  ]);
  assert.equal(body.reasoning_effort, "low");
});

test("fromOpenAiResponse maps message, finish_reason, and usage to the Anthropic shape", () => {
  const out = fromOpenAiResponse({
    id: "c1",
    model: "deepseek-v4-pro",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        reasoning_content: "think",
        tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(out.id, "c1");
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(out.content, [
    { type: "thinking", thinking: "think" },
    { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } },
  ]);
});

test("consumeOpenAiStream opens a 3rd parallel call without tripping the ambiguity guard", async () => {
  // Regression: the guard once fired on the opening delta of the 3rd call (index present but not yet
  // registered), breaking every run with 3+ parallel tools.
  const res = resFrom([
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } }] } }] }),
    chunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"b"}' } }] } }] }),
    chunk({ choices: [{ delta: { tool_calls: [{ index: 2, id: "c3", function: { name: "read_file", arguments: '{"path":"c"}' } }] } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.content.map(b => b.input.path), ["a", "b", "c"]);
});

test("consumeOpenAiStream still accepts a bare argument fragment when only one call is open", async () => {
  const res = resFrom([
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":' } }] } }] }),
    chunk({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"a.txt"}' } }] } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.content, [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } }]);
});

test("assistant text and thinking blocks join with a newline, never fuse", () => {
  const body = toOpenAiBody({ messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "scaffold first" }, { type: "thinking", thinking: "now write" },
      { type: "text", text: "Scaffolding." }, { type: "text", text: "Writing." },
    ] },
  ] });
  const asst = body.messages.at(-1);
  assert.equal(asst.content, "Scaffolding.\nWriting.");
  assert.equal(asst.reasoning_content, "scaffold first\nnow write");
});

test("an empty reasoning_content is not stored as a thinking block", () => {
  const r = fromOpenAiResponse({ id: "c", choices: [{ finish_reason: "stop", message: { content: "hi", reasoning_content: "" } }] });
  assert.deepEqual(r.content, [{ type: "text", text: "hi" }]);
});

test("fromOpenAiResponse: object-valued tool arguments are taken as-is, not dropped to {}", () => {
  const out = fromOpenAiResponse({
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "read_file", arguments: { path: "/a" } } }] },
    }],
  });
  assert.deepEqual(out.content[0], { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } });
});

test("mapStop passes through a finish_reason that collides with an Object prototype key", () => {
  const out = fromOpenAiResponse({ choices: [{ finish_reason: "constructor", message: { role: "assistant", content: "hi" } }] });
  assert.equal(out.stop_reason, "constructor");
  assert.equal(fromOpenAiResponse({ choices: [{ finish_reason: "toString", message: {} }] }).stop_reason, "toString");
});

const resFrom = (chunks) => ({ body: streamFromChunks(chunks) });
const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

test("consumeOpenAiStream: reasoning + text + tool_calls deltas rebuild Anthropic blocks", async () => {
  const events = [];
  const res = resFrom([
    chunk({ id: "c1", model: "deepseek-v4-pro", choices: [{ delta: { role: "assistant", reasoning_content: "thi" } }] }),
    chunk({ choices: [{ delta: { reasoning_content: "nk" } }] }),
    chunk({ choices: [{ delta: { content: "read" } }] }),
    // arguments split across chunks; id/name only on the first delta of the call
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read_file", arguments: '{"pa' } }] } }] }),
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/a"}' } }] } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: "tool_calls", usage: { prompt_tokens: 7, completion_tokens: 3 } }] }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, (e) => events.push(e));
  assert.equal(out.id, "c1");
  assert.equal(out.model, "deepseek-v4-pro");
  assert.equal(out.stop_reason, "tool_use");
  assert.deepEqual(out.usage, { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(out.content, [
    { type: "thinking", thinking: "think" },
    { type: "text", text: "read" },
    { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } },
  ]);
  assert.deepEqual(events.filter(e => e.type === "text_delta"), [{ type: "text_delta", index: 1, text: "read" }]);
  assert.deepEqual(events.filter(e => e.type === "tool_use_complete"),
    [{ type: "tool_use_complete", index: 2, id: "t1", name: "read_file", input: { path: "/a" } }]);
  // message_complete is emitted by finalizeResponse (after validation), not by the consumer.
  assert.equal(events.some(e => e.type === "message_complete"), false);
});

test("toOpenAiBody: LLM_MAX_TOKENS_PARAM=max_completion_tokens switches the field (OpenAI reasoning)", () => {
  const body = toOpenAiBody({ messages: [{ role: "user", content: "hi" }], maxTokens: 200, maxTokensParam: "max_completion_tokens", model: "m" });
  assert.equal(body.max_completion_tokens, 200);
  assert.equal(body.max_tokens, undefined);
});

test("consumeOpenAiStream streams a safety refusal as visible text", async () => {
  const events = [];
  const res = resFrom([
    chunk({ choices: [{ delta: { refusal: "I can't " } }] }),
    chunk({ choices: [{ delta: { refusal: "help with that." }, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, (e) => events.push(e));
  assert.deepEqual(out.content, [{ type: "text", text: "I can't help with that." }]);
  assert.deepEqual(events.filter(e => e.type === "text_delta").map(e => e.text), ["I can't ", "help with that."]);
});

test("message_complete fires only after the shared gate passes", async () => {
  const events = [];
  // a blank turn fails the gate — the consumer must not have announced completion first
  const blank = resFrom([chunk({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"]);
  await assert.rejects(() => callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" },
    messages: [{ role: "user", content: "hi" }],
    onDelta: (e) => events.push(e),
    fetcher: async () => ({ ok: true, status: 200, body: blank.body }),
  }), /no displayable content/);
  assert.equal(events.some(e => e.type === "message_complete"), false, "no completion event for a rejected turn");

  // a good turn does emit it
  const ok = resFrom([chunk({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"]);
  const seen = [];
  await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" },
    messages: [{ role: "user", content: "hi" }],
    onDelta: (e) => seen.push(e),
    fetcher: async () => ({ ok: true, status: 200, body: ok.body }),
  });
  assert.deepEqual(seen.at(-1), { type: "message_complete", stop_reason: "end_turn" });
});

test("consumeOpenAiStream stops at [DONE] and ignores anything after it", async () => {
  const res = resFrom([
    chunk({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
    chunk({ choices: [{ delta: { content: "AFTER" } }] }),
  ]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.content, [{ type: "text", text: "hi" }]);
  assert.equal(out.stop_reason, "end_turn");
});

test("consumeOpenAiStream: a data frame split across reads still parses", async () => {
  const whole = chunk({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
  const res = resFrom([whole.slice(0, 25), whole.slice(25)]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.content, [{ type: "text", text: "hello" }]);
  assert.equal(out.stop_reason, "end_turn");
});

test("consumeOpenAiStream: parallel tool_calls without index don't collapse into one", async () => {
  const res = resFrom([
    chunk({ choices: [{ delta: { tool_calls: [{ id: "t1", function: { name: "read_file", arguments: '{"path":"/a"}' } }] } }] }),
    chunk({ choices: [{ delta: { tool_calls: [{ id: "t2", function: { name: "read_file", arguments: '{"path":"/b"}' } }] } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.content, [
    { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } },
    { type: "tool_use", id: "t2", name: "read_file", input: { path: "/b" } },
  ]);
});

test("consumeOpenAiStream: object-valued arguments delta is captured, not dropped", async () => {
  const res = resFrom([
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read_file", arguments: { path: "/a" } } }] } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.content, [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "/a" } }]);
});

test("consumeOpenAiStream captures usage from a choices-empty trailer chunk", async () => {
  const res = resFrom([
    chunk({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
    chunk({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
    "data: [DONE]\n\n",
  ]);
  const out = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(out.usage, { input_tokens: 4, output_tokens: 2 });
});

test("consumeOpenAiStream throws opaquely on an upstream error frame", async () => {
  const res = resFrom([chunk({ error: { message: "secret prompt echo" } })]);
  await assert.rejects(() => consumeOpenAiStream(res, () => {}), (err) => {
    assert.equal(err.message, "LLM stream error");
    return true;
  });
});

test("resolveLlmConfig: LLM_API_SHAPE=openai flips the shape and the default base URL", () => {
  const cfg = resolveLlmConfig({ LLM_API_SHAPE: "openai" });
  assert.equal(cfg.apiShape, "openai");
  assert.equal(cfg.baseUrl, "https://api.deepseek.com");
  assert.equal(
    resolveLlmConfig({ LLM_API_SHAPE: "openai", LLM_BASE_URL: "https://api.deepseek.com/" }).baseUrl,
    "https://api.deepseek.com",
  );
  // Only absent/empty (and an explicit "anthropic") default to the Anthropic shape.
  for (const ok of [undefined, "", "anthropic"]) {
    const c = resolveLlmConfig({ LLM_API_SHAPE: ok });
    assert.equal(c.apiShape, "anthropic");
    assert.equal(c.baseUrl, "https://api.deepseek.com/anthropic");
  }
  // A non-empty typo must throw, not silently fall back (which would send the key to DeepSeek).
  for (const bad of ["OpenAI", "openai ", "azure", "OPENAI"]) {
    assert.throws(() => resolveLlmConfig({ LLM_API_SHAPE: bad }), /invalid LLM_API_SHAPE/);
  }
  // The bad value itself must never appear — this message reaches the UI, and a misplaced secret
  // pasted into the variable would be published with it.
  assert.throws(() => resolveLlmConfig({ LLM_API_SHAPE: "sk-SECRET-LEAK" }), (err) => {
    assert.ok(!err.message.includes("SECRET"), `leaked the value: ${err.message}`);
    return true;
  });
});

test("callLlmMessages in openai shape hits /chat/completions with Bearer-only auth", async () => {
  const calls = [];
  const fakeRes = {
    ok: true,
    async json() {
      return { id: "c1", model: "m", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }] };
    },
  };
  const out = await callLlmMessages({
    env: { LLM_API_KEY: "sk-t", LLM_API_SHAPE: "openai" },
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "x", description: "d", input_schema: { type: "object" } }],
    fetcher: async (u, init) => { calls.push({ u, init }); return fakeRes; },
  });
  assert.equal(calls[0].u, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].init.headers["authorization"], "Bearer sk-t");
  assert.equal(calls[0].init.headers["x-api-key"], undefined);
  assert.equal(calls[0].init.headers["anthropic-version"], undefined);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.tools[0].type, "function");
  assert.equal(out.stop_reason, "end_turn");
  assert.deepEqual(out.content, [{ type: "text", text: "OK" }]);
});

test("callLlmMessages openai streaming requests stream_options.include_usage", async () => {
  let body;
  const sse = "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n";
  await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" },
    messages: [{ role: "user", content: "hi" }],
    onDelta: () => {},
    fetcher: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, body: streamFromChunks([sse]) }; },
  });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("truncated tool arguments degrade to {} so the tool — not the run — rejects them", async () => {
  const res = { body: streamFromString(
    'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","function":{"name":"write_file","arguments":"{\\"path\\":\\"/w/a"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    + "data: [DONE]\n\n") };
  const r = await consumeOpenAiStream(res, () => {});
  assert.deepEqual(r.content.find(b => b.type === "tool_use").input, {});
});

test("a body that ends without the final blank line still yields its last frame", async () => {
  const res = { body: streamFromString(
    'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + "data: [DONE]") };
  const r = await consumeOpenAiStream(res, () => {});
  assert.equal(r.stop_reason, "end_turn");
});

test("toOpenAiBody drops an assistant turn it recognizes nothing in, rather than posting empty content", () => {
  const body = toOpenAiBody({ messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "xx" }] },
  ] });
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("finish_reason 'stop' alongside tool_calls still maps to tool_use, so the batch is dispatched", () => {
  const r = fromOpenAiResponse({ id: "c", choices: [{ finish_reason: "stop", message: {
    content: "writing it", tool_calls: [{ id: "call_0", function: { name: "write_file", arguments: "{}" } }],
  } }] });
  assert.equal(r.stop_reason, "tool_use");
});

test("numeric tool-call ids don't collide with index keys", async () => {
  const res = { body: streamFromString(
    'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"id":1,"function":{"name":"read_file","arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":2,"function":{"name":"read_file","arguments":"{\\"path\\":\\"/b\\"}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    + "data: [DONE]\n\n") };
  const r = await consumeOpenAiStream(res, () => {});
  const tus = r.content.filter(b => b.type === "tool_use");
  assert.deepEqual(tus.map(t => t.id), ["1", "2"]);
  assert.deepEqual(tus.map(t => t.input), [{ path: "/a" }, { path: "/b" }]);
});

test("a non-JSON data frame is skipped, not fatal", async () => {
  const res = { body: streamFromString(
    'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\n\n'
    + "data: keep-alive\n\n"
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + "data: [DONE]\n\n") };
  const r = await consumeOpenAiStream(res, () => {});
  assert.equal(r.content.find(b => b.type === "text").text, "hi");
});

test("a cut-short OpenAI turn keeps the finished tool call and drops the half-streamed one", async () => {
  const sse =
    'data: {"id":"c","choices":[{"delta":{"content":"writing"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"write_file","arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"t2","function":{"name":"write_file","arguments":"{\\"path\\":\\"/b\\",\\"content\\":\\"half"}}]}}]}\n\n';
  const r = await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" }, messages: [{ role: "user", content: "hi" }],
    onDelta: () => {}, signal: { aborted: true, reason: "llm_timeout" },
    salvageOnAbort: (reason) => reason === "llm_timeout",
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(sse) }),
  });
  assert.equal(r.salvaged, true);
  assert.equal(r.stop_reason, "tool_use");
  const tools = r.content.filter(b => b.type === "tool_use");
  assert.deepEqual(tools.map(t => t.id), ["t1"]);
  assert.deepEqual(tools[0].input, { path: "/a" });
});

test("a call cut between its opening delta and the first argument fragment is dropped", async () => {
  const sse =
    'data: {"id":"c","choices":[{"delta":{"content":"working"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"deploy_test"}}]}}]}\n\n';
  const r = await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" }, messages: [{ role: "user", content: "hi" }],
    onDelta: () => {}, signal: { aborted: true, reason: "llm_timeout" }, salvageOnAbort: () => true,
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(sse) }),
  });
  // Zero argument bytes means the cut landed before the arguments started — not a closed no-arg call
  // (those stream "{}"). Dispatching it would run deploy_test on a half-edited workspace.
  assert.deepEqual(r.content.map(b => b.type), ["text"]);
  assert.equal(r.stop_reason, "max_tokens");
});

test("a no-arg call whose {} actually streamed is kept under salvage", async () => {
  const sse =
    'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"deploy_test","arguments":"{}"}}]}}]}\n\n';
  const r = await callLlmMessages({
    env: { LLM_API_KEY: "k", LLM_API_SHAPE: "openai" }, messages: [{ role: "user", content: "hi" }],
    onDelta: () => {}, signal: { aborted: true, reason: "llm_timeout" }, salvageOnAbort: () => true,
    fetcher: async () => ({ ok: true, status: 200, body: streamThenError(sse) }),
  });
  assert.equal(r.stop_reason, "tool_use");
  assert.deepEqual(r.content[0].input, {});
});

test("an id-only opening delta and an index+id continuation resolve to one tool call", async () => {
  const res = { body: streamFromString(
    'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"id":"call_9","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"arguments":"th\\":\\"/a\\"}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    + "data: [DONE]\n\n") };
  const r = await consumeOpenAiStream(res, () => {});
  const tus = r.content.filter(b => b.type === "tool_use");
  assert.equal(tus.length, 1);
  assert.deepEqual(tus[0].input, { path: "/a" });
});

test("an id-only opening delta with index-only continuations stays one tool call", async () => {
  const res = { body: streamFromString(
    'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"id":"call_7","function":{"name":"read_file"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
    + "data: [DONE]\n\n") };
  const r = await consumeOpenAiStream(res, () => {});
  const tus = r.content.filter(b => b.type === "tool_use");
  assert.equal(tus.length, 1);
  assert.equal(tus[0].id, "call_7");
  assert.deepEqual(tus[0].input, { path: "/a" });
});

test("content-parts array form still yields the assistant text", () => {
  const r = fromOpenAiResponse({ id: "c", choices: [{ finish_reason: "stop",
    message: { content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] } }] });
  assert.equal(r.content.find(b => b.type === "text").text, "part one part two");
});

test("content and refusal land in separate blocks, never fused", () => {
  const r = fromOpenAiResponse({ id: "c", choices: [{ finish_reason: "stop",
    message: { content: "Here is part one.", refusal: "I can't help with the rest." } }] });
  const texts = r.content.filter(b => b.type === "text").map(b => b.text);
  assert.deepEqual(texts, ["Here is part one.", "I can't help with the rest."]);
});

test("bare-CR line terminators still frame the stream", async () => {
  const sse = 'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\r\r'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\r'
    + "data: [DONE]\r\r";
  const r = await consumeOpenAiStream({ body: streamFromString(sse) }, () => {});
  assert.equal(r.content.find(b => b.type === "text").text, "hi");
  assert.equal(r.stop_reason, "end_turn");
});

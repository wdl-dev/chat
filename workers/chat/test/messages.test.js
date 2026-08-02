import { test } from "node:test";
import assert from "node:assert/strict";
import { healMessages, isUserTextTurn, replayLlmTurnOutcome, replayPlanOutcome, toolBatchAlreadyRan, windowLlmMessages } from "../src/messages.js";

function asst(...blocks) { return { role: "assistant", content: blocks }; }
function user(...blocks) { return { role: "user", content: blocks }; }
function toolUse(id, name = "t") { return { type: "tool_use", id, name, input: {} }; }
function toolResult(id, content = "{}") { return { type: "tool_result", tool_use_id: id, content }; }
function text(s) { return { type: "text", text: s }; }
function thinking(t) { return { type: "thinking", thinking: t }; }

test("healMessages preserves a clean log", () => {
  const input = [
    user(text("hi")),
    asst(text("ok"), toolUse("a")),
    user(toolResult("a")),
    asst(text("done")),
  ];
  const out = healMessages(input);
  assert.equal(out.length, 4);
  assert.deepEqual(out[2].content, [toolResult("a")]);
});

test("healMessages strips orphan tool_result whose previous message isn't the matching assistant", () => {
  const input = [
    asst(toolUse("MNw99")),
    asst(toolUse("q4mL")),
    user(toolResult("q4mL")),
    user(toolResult("MNw99")),
  ];
  const out = healMessages(input);
  assert.equal(out.length, 4);
  assert.equal(out[0].role, "assistant");
  assert.deepEqual(out[0].content, [toolUse("MNw99")]);
  assert.equal(out[1].role, "user");
  assert.equal(out[1].content[0].type, "tool_result");
  assert.equal(out[1].content[0].tool_use_id, "MNw99");
  assert.equal(out[1].content[0].is_error, true);
  assert.equal(out[2].role, "assistant");
  assert.deepEqual(out[2].content, [toolUse("q4mL")]);
  assert.equal(out[3].role, "user");
  assert.deepEqual(out[3].content, [toolResult("q4mL")]);
});

test("healMessages strips orphan but keeps text in mixed user content", () => {
  const input = [
    asst(toolUse("a")),
    user(toolResult("a")),
    user(text("ping"), toolResult("ghost")),
  ];
  const out = healMessages(input);
  assert.equal(out.length, 3);
  assert.equal(out[2].content.length, 1);
  assert.deepEqual(out[2].content[0], text("ping"));
});

test("healMessages synthesizes missing tool_result when next user lacks it", () => {
  const input = [
    asst(toolUse("a"), toolUse("b")),
    user(toolResult("a")),
  ];
  const out = healMessages(input);
  assert.equal(out.length, 2);
  assert.equal(out[1].content.length, 2);
  assert.equal(out[1].content[0].tool_use_id, "a");
  assert.equal(out[1].content[1].tool_use_id, "b");
  assert.equal(out[1].content[1].is_error, true);
  const parsed = JSON.parse(out[1].content[1].content);
  assert.equal(parsed.aborted, true);
});

test("healMessages synthesizes missing tool_result when next message isn't a user", () => {
  const input = [
    asst(toolUse("a")),
    asst(text("next")),
  ];
  const out = healMessages(input);
  assert.equal(out.length, 3);
  assert.equal(out[1].role, "user");
  assert.equal(out[1].content[0].tool_use_id, "a");
  assert.equal(out[1].content[0].is_error, true);
  assert.equal(out[2].role, "assistant");
});

test("healMessages does not modify or drop thinking blocks", () => {
  const input = [
    asst(thinking("内部思考"), text("外部文字")),
    user(text("ok")),
  ];
  const out = healMessages(input);
  assert.equal(out[0].content[0].type, "thinking");
  assert.equal(out[0].content[0].thinking, "内部思考");
});

test("healMessages doesn't mutate the input array or its message objects", () => {
  const before = [
    asst(toolUse("a")),
    user(toolResult("a")),
  ];
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  healMessages(before);
  assert.deepEqual(before, beforeSnapshot);
});

test("healMessages handles same-id pairing across orphan-then-synth combo", () => {
  const input = [
    asst(toolUse("orphan-a")),
    asst(toolUse("ok-b")),
    user(toolResult("ok-b")),
    user(toolResult("orphan-a")),
  ];
  const out = healMessages(input);
  assert.equal(out[1].role, "user");
  assert.equal(out[1].content[0].tool_use_id, "orphan-a");
  assert.equal(out[1].content[0].is_error, true);
});

test("windowLlmMessages passes a short clean log through (no windowing)", () => {
  const raw = [user(text("hi")), asst(text("ok"))];
  const out = windowLlmMessages(raw, { maxMessages: 60 });
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
  assert.equal(out.at(-1).content[0].text, "ok");
});

test("windowLlmMessages keeps the last maxMessages and starts on a user role", () => {
  const raw = [];
  for (let i = 0; i < 10; i++) { raw.push(user(text(`u${i}`))); raw.push(asst(text(`a${i}`))); }
  const out = windowLlmMessages(raw, { maxMessages: 4 });
  assert.ok(out.length <= 4);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content[0].text, "u8");
  assert.equal(out.at(-1).content[0].text, "a9");
});

test("windowLlmMessages strips tool blocks in plan mode (stripTools)", () => {
  const raw = [
    user(text("build x")),
    asst(text("sure"), toolUse("t1")),
    user(toolResult("t1")),
    asst(text("done")),
  ];
  const out = windowLlmMessages(raw, { stripTools: true, maxMessages: 60 });
  const blocks = out.flatMap(m => Array.isArray(m.content) ? m.content : []);
  assert.ok(!blocks.some(b => b.type === "tool_use" || b.type === "tool_result"));
  assert.ok(out.every(m => Array.isArray(m.content) && m.content.length > 0));
});

test("windowLlmMessages drops an orphan tool_result left at the window boundary", () => {
  const raw = [
    asst(text("a0"), toolUse("t0")),
    user(toolResult("t0"), text("more")),
    asst(text("a1")),
    user(text("u2")),
    asst(text("a2")),
  ];
  const out = windowLlmMessages(raw, { maxMessages: 4 });
  assert.equal(out[0].role, "user");
  assert.ok(!out[0].content.some(b => b.type === "tool_result"));
  assert.ok(out[0].content.some(b => b.type === "text" && b.text === "more"));
});

test("windowLlmMessages preserves thinking blocks", () => {
  const raw = [user(text("hi")), asst(thinking("hmm"), text("ok"))];
  const out = windowLlmMessages(raw, { maxMessages: 60 });
  const asstMsg = out.find(m => m.role === "assistant");
  assert.ok(asstMsg.content.some(b => b.type === "thinking" && b.thinking === "hmm"));
});

test("windowLlmMessages yields empty when nothing user-anchored survives healing", () => {
  const out = windowLlmMessages([asst(text("orphan assistant"))], { maxMessages: 60 });
  assert.equal(out.length, 0);
});

test("windowLlmMessages falls back to the last user text when the window heals to empty", () => {
  // maxMessages=1 windows past the user to the trailing assistant, heals to empty;
  // the fallback rebuilds a text-only user message from raw so the API isn't sent [].
  const out = windowLlmMessages([user(text("first ask")), asst(text("a1"))], { maxMessages: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.deepEqual(out[0].content, [{ type: "text", text: "first ask" }]);
});

test("replayLlmTurnOutcome replays a completed turn and skips one still pending", () => {
  assert.equal(replayLlmTurnOutcome(null), null);
  assert.equal(replayLlmTurnOutcome({ role: "user", content: JSON.stringify([text("hi")]) }), null);
  assert.deepEqual(
    replayLlmTurnOutcome({ role: "assistant", content: JSON.stringify([text("done")]) }),
    { outcome: "done", stopReason: "end_turn", hasToolUses: false },
  );
  assert.deepEqual(
    replayLlmTurnOutcome({ role: "assistant", content: JSON.stringify([toolUse("t1")]) }),
    { outcome: "done", stopReason: "tool_use", hasToolUses: true },
  );
});

test("replayLlmTurnOutcome omits hasOutput — replay is faithful to the recorded turn", () => {
  // A blank/thinking-only turn a previous version recorded as success must not replay as failed.
  const r = replayLlmTurnOutcome({ role: "assistant", content: JSON.stringify([{ type: "thinking", thinking: "..." }]) });
  assert.equal(r.hasToolUses, false);
  assert.equal("hasOutput" in r, false);
});

test("toolBatchAlreadyRan is true only for a user turn carrying tool_result", () => {
  assert.equal(toolBatchAlreadyRan({ role: "user", content: JSON.stringify([toolResult("t1")]) }), true);
  assert.equal(toolBatchAlreadyRan({ role: "user", content: JSON.stringify([text("hi")]) }), false);
  assert.equal(toolBatchAlreadyRan({ role: "assistant", content: JSON.stringify([toolUse("t1")]) }), false);
  assert.equal(toolBatchAlreadyRan(null), false);
});

test("replayLlmTurnOutcome prefers the persisted stop_reason over the fabricated one", () => {
  // a max_tokens-truncated turn with tool_use blocks must replay as its real stop, not "tool_use"
  assert.deepEqual(
    replayLlmTurnOutcome({ role: "assistant", content: JSON.stringify([toolUse("t1")]) }, "max_tokens"),
    { outcome: "done", stopReason: "max_tokens", hasToolUses: true },
  );
  // falls back to fabrication when no stop_reason was persisted
  assert.equal(replayLlmTurnOutcome({ role: "assistant", content: JSON.stringify([toolUse("t1")]) }, "").stopReason, "tool_use");
});

test("replayPlanOutcome returns the recorded plan text for an assistant, else null", () => {
  assert.equal(replayPlanOutcome({ role: "user", content: JSON.stringify([text("hi")]) }), null);
  assert.equal(replayPlanOutcome(null), null);
  assert.deepEqual(
    replayPlanOutcome({ role: "assistant", content: JSON.stringify([text("the plan")]) }),
    { outcome: "done", plan: "the plan" },
  );
});

test("isUserTextTurn matches only a single-text user turn with the exact text", () => {
  assert.equal(isUserTextTurn({ role: "user", content: JSON.stringify([text("add auth")]) }, "add auth"), true);
  assert.equal(isUserTextTurn({ role: "user", content: JSON.stringify([text("other")]) }, "add auth"), false);
  assert.equal(isUserTextTurn({ role: "assistant", content: JSON.stringify([text("add auth")]) }, "add auth"), false);
  assert.equal(isUserTextTurn({ role: "user", content: JSON.stringify([text("add auth"), text("x")]) }, "add auth"), false);
  assert.equal(isUserTextTurn(null, "add auth"), false);
});

function assertAlternating(msgs) {
  for (let i = 1; i < msgs.length; i++) {
    assert.notEqual(msgs[i].role, msgs[i - 1].role, `adjacent same-role turns at ${i}`);
  }
}

test("windowLlmMessages coalesces consecutive same-role turns into an alternating array", () => {
  // plan-mode stripTools removes the tool turns, leaving two assistant turns.
  const plan = windowLlmMessages(
    [user(text("build x")), asst(text("sure"), toolUse("t1")), user(toolResult("t1")), asst(text("done"))],
    { stripTools: true, maxMessages: 60 },
  );
  assertAlternating(plan);

  // a mid-tool supersede leaves user(tool_result) then user(text).
  const supersede = windowLlmMessages(
    [user(text("build x")), asst(text("working"), toolUse("t1")), user(toolResult("t1")), user(text("make it blue"))],
    { maxMessages: 60 },
  );
  assertAlternating(supersede);
  const lastUser = supersede[supersede.length - 1];
  assert.ok(lastUser.content.some(b => b.type === "tool_result"), "keeps the tool_result");
  assert.ok(lastUser.content.some(b => b.type === "text" && b.text === "make it blue"), "keeps the new text");

  // three consecutive user turns (accumulated after a 400) also collapse
  assertAlternating(windowLlmMessages(
    [user(text("a")), asst(text("x")), user(text("b")), user(text("c")), user(text("d"))],
    { maxMessages: 60 },
  ));
});

test("windowLlmMessages does not collapse a long tool-only agentic tail", () => {
  const raw = [user(text("build x"))];
  for (let i = 0; i < 40; i++) { raw.push(asst(text("step " + i), toolUse("t" + i))); raw.push(user(toolResult("t" + i))); }
  const out = windowLlmMessages(raw, { maxMessages: 20 });
  assert.ok(out.length > 1, "must not collapse to a single turn / empty");
  assert.equal(out[0].role, "user");
  assertAlternating(out);
  const blocks = out.flatMap(m => Array.isArray(m.content) ? m.content : []);
  assert.ok(blocks.some(b => b.type === "tool_result"), "keeps recent tool_results");
});

test("windowLlmMessages prunes an empty assistant turn and coalesces the neighbours", () => {
  const out = windowLlmMessages([user(text("hi")), { role: "assistant", content: [] }, user(text("again"))], { maxMessages: 60 });
  assert.ok(out.every(m => m.role !== "assistant" || (Array.isArray(m.content) && m.content.length > 0)), "no empty assistant");
  assertAlternating(out);
});

test("coalesceRoles keeps thinking blocks leading when merging assistant turns", () => {
  const out = windowLlmMessages(
    [user(text("q")), asst(thinking("t1"), text("a1")), asst(thinking("t2"), text("a2"))],
    { maxMessages: 60 },
  );
  const a = out.find(m => m.role === "assistant");
  let sawNonThinking = false;
  for (const b of a.content) {
    if (b.type === "thinking") assert.ok(!sawNonThinking, "a thinking block followed a non-thinking block");
    else sawNonThinking = true;
  }
});

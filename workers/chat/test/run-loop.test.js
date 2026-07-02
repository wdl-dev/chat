import { test } from "node:test";
import assert from "node:assert/strict";
import { runChatRun } from "../src/run-loop.js";

// step.do(name, optsOrFn, maybeFn) runs fn (records the name); waitForEvent
// returns the scripted event or null (timeout). throwOn injects a step failure.
function makeStep({ events = {}, throwOn } = {}) {
  const names = [];
  const calls = [];
  const step = {
    do: async (name, a, b) => {
      names.push(name);
      const hasOpts = typeof a !== "function";
      calls.push({ name, opts: hasOpts ? a : undefined });
      if (throwOn && name === throwOn.name) throw throwOn.error;
      const fn = hasOpts ? b : a;
      return await fn();
    },
    waitForEvent: async (name) => (name in events ? events[name] : null),
  };
  return { step, names, calls };
}

// Each sd method returns script[key] (array => consumed per call) or a default.
function makeSd(script = {}) {
  const ends = [];
  const calls = [];
  const q = { ...script };
  const next = (key, def) => {
    const v = q[key];
    if (Array.isArray(v)) return v.length ? v.shift() : def;
    return v ?? def;
  };
  const sd = {
    workflowStartRun: async () => { calls.push("start"); return next("start", { ok: true }); },
    workflowIsCancelled: async () => { calls.push("cancel"); return next("cancelled", false); },
    workflowExecuteLlmTurn: async () => { calls.push("llm"); return next("llm", { outcome: "done", stopReason: "end_turn", hasToolUses: false }); },
    workflowRunToolBatch: async () => { calls.push("tools"); return next("tools", { outcome: "done" }); },
    workflowDraftPlan: async () => { calls.push("draft"); return next("draft", { outcome: "done", plan: "PLAN" }); },
    workflowRevisePlan: async () => { calls.push("revise"); return next("revise", { outcome: "done", plan: "PLAN2" }); },
    workflowAfterPlanApprove: async () => { calls.push("approve"); return { ok: true }; },
    workflowEndRun: async (args) => { ends.push(args); calls.push(`end:${args.status}`); return { ok: true }; },
  };
  return { sd, ends, calls };
}

const free = { runId: "r1", mode: "free_form" };

test("start skip short-circuits the run", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({ start: { skip: true, reason: "status=done" } });
  assert.deepEqual(await runChatRun(step, sd, free), { runId: "r1", outcome: "skipped", reason: "status=done" });
  assert.equal(ends.length, 0);
});

test("a cancelled run ends aborted before calling the LLM", async () => {
  const { step } = makeStep();
  const { sd, ends, calls } = makeSd({ cancelled: true });
  assert.deepEqual(await runChatRun(step, sd, free), { runId: "r1", outcome: "aborted" });
  assert.deepEqual(ends, [{ runId: "r1", status: "aborted" }]);
  assert.ok(!calls.includes("llm"));
});

test("a plain LLM turn (no tool_use) ends done", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({ llm: { outcome: "done", stopReason: "end_turn", hasToolUses: false } });
  assert.deepEqual(await runChatRun(step, sd, free), { runId: "r1", outcome: "done", stopReason: "end_turn" });
  assert.deepEqual(ends, [{ runId: "r1", status: "done", stopReason: "end_turn" }]);
});

test("an aborted LLM turn ends aborted", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({ llm: { outcome: "aborted" } });
  assert.deepEqual(await runChatRun(step, sd, free), { runId: "r1", outcome: "aborted" });
  assert.deepEqual(ends, [{ runId: "r1", status: "aborted" }]);
});

test("a failed LLM turn ends failed with the error", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({ llm: { outcome: "failed", error: "deepseek 500" } });
  const out = await runChatRun(step, sd, free);
  assert.deepEqual(out, { runId: "r1", outcome: "failed", error: "deepseek 500" });
  assert.deepEqual(ends, [{ runId: "r1", status: "failed", error: "deepseek 500" }]);
});

test("a tool_use turn runs the batch, then the next turn ends done", async () => {
  const { step, names } = makeStep();
  const { sd, ends } = makeSd({
    llm: [
      { outcome: "done", stopReason: "tool_use", hasToolUses: true },
      { outcome: "done", stopReason: "end_turn", hasToolUses: false },
    ],
    tools: { outcome: "done" },
  });
  assert.deepEqual(await runChatRun(step, sd, free), { runId: "r1", outcome: "done", stopReason: "end_turn" });
  assert.ok(names.includes("tools-1") && names.includes("llm-2"));
  assert.deepEqual(ends, [{ runId: "r1", status: "done", stopReason: "end_turn" }]);
});

test("an aborted tool batch ends aborted", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({
    llm: { outcome: "done", stopReason: "tool_use", hasToolUses: true },
    tools: { outcome: "aborted" },
  });
  assert.deepEqual(await runChatRun(step, sd, free), { runId: "r1", outcome: "aborted" });
  assert.deepEqual(ends, [{ runId: "r1", status: "aborted" }]);
});

test("an endless tool loop terminates at MAX_TURNS", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({
    llm: { outcome: "done", stopReason: "tool_use", hasToolUses: true },
    tools: { outcome: "done" },
  });
  const out = await runChatRun(step, sd, free);
  assert.equal(out.outcome, "failed");
  assert.match(out.error, /exceeded MAX_TURNS/);
  assert.equal(ends.at(-1).status, "failed");
});

test("a re-dispatch/stale-claim step error is NOT settled as failed (re-dispatch owns the run)", async () => {
  const { step } = makeStep({ throwOn: { name: "start", error: new Error("Workflow run claim does not match instance state") } });
  const { sd, ends } = makeSd();
  await assert.rejects(() => runChatRun(step, sd, free), /run claim does not match/);
  assert.equal(ends.length, 0, "must not mark the run failed on a re-dispatch race");
});

test("a genuine step error is settled as failed, then rethrown", async () => {
  const { step } = makeStep({ throwOn: { name: "start", error: new Error("kaboom") } });
  const { sd, ends } = makeSd();
  await assert.rejects(() => runChatRun(step, sd, free), /kaboom/);
  assert.deepEqual(ends, [{ runId: "r1", status: "failed", error: "workflow error: kaboom" }]);
});

const plan = { runId: "r1", mode: "plan_confirmed" };

test("plan-confirmed: approve runs the plan to a done free-form turn", async () => {
  const { step, names } = makeStep({ events: { "plan_approval-0": { decision: "approve" } } });
  const { sd, ends, calls } = makeSd();
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "done", stopReason: "end_turn" });
  assert.ok(calls.includes("draft") && calls.includes("approve"));
  assert.ok(names.includes("exec-end-done-1"), "free-form runs with the exec- prefix after approval");
  assert.equal(ends.at(-1).status, "done");
});

test("plan-confirmed: reject ends aborted", async () => {
  const { step } = makeStep({ events: { "plan_approval-0": { decision: "reject" } } });
  const { sd, ends } = makeSd();
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "aborted", reason: "plan_rejected" });
  assert.deepEqual(ends, [{ runId: "r1", status: "aborted", error: "plan_rejected" }]);
});

test("plan-confirmed: no approval event (timeout) ends aborted", async () => {
  const { step } = makeStep({ events: {} });
  const { sd, ends } = makeSd();
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "aborted", reason: "plan_timeout" });
  assert.equal(ends.at(-1).error, "plan_approval timeout");
});

test("plan-confirmed: revise then approve re-drafts and proceeds", async () => {
  const { step } = makeStep({ events: { "plan_approval-0": { decision: "revise", note: "tweak" }, "plan_approval-1": { decision: "approve" } } });
  const { sd, calls } = makeSd();
  const out = await runChatRun(step, sd, plan);
  assert.equal(out.outcome, "done");
  assert.ok(calls.includes("revise"), "a revise decision re-drafts the plan");
});

test("plan-confirmed: a cancelled plan phase ends aborted before drafting", async () => {
  const { step } = makeStep();
  const { sd, ends, calls } = makeSd({ cancelled: true });
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "aborted" });
  assert.deepEqual(ends, [{ runId: "r1", status: "aborted" }]);
  assert.ok(!calls.includes("draft"));
});

test("plan-confirmed: an aborted draft ends aborted", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({ draft: { outcome: "aborted" } });
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "aborted" });
  assert.deepEqual(ends, [{ runId: "r1", status: "aborted" }]);
});

test("plan-confirmed: a failed draft ends failed with the error", async () => {
  const { step } = makeStep();
  const { sd, ends } = makeSd({ draft: { outcome: "failed", error: "plan boom" } });
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "failed", error: "plan boom" });
  assert.deepEqual(ends, [{ runId: "r1", status: "failed", error: "plan boom" }]);
});

test("plan-confirmed: exhausting MAX_PLAN_REVISE ends aborted", async () => {
  const events = {};
  for (let i = 0; i <= 3; i++) events[`plan_approval-${i}`] = { decision: "revise" };
  const { step } = makeStep({ events });
  const { sd, ends } = makeSd();
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "aborted", reason: "plan_revise_exhausted" });
  assert.equal(ends.at(-1).error, "plan_revise_exhausted");
});

test("plan-confirmed: an invalid decision ends failed", async () => {
  const { step } = makeStep({ events: { "plan_approval-0": { decision: "nonsense" } } });
  const { sd, ends } = makeSd();
  const out = await runChatRun(step, sd, plan);
  assert.equal(out.outcome, "failed");
  assert.match(out.error, /invalid plan decision: nonsense/);
  assert.match(ends.at(-1).error, /invalid plan decision/);
});

test("the LLM and tool steps disable retries so re-dispatch can't double-execute them", async () => {
  const { step, calls } = makeStep();
  const { sd } = makeSd({
    llm: [{ outcome: "done", stopReason: "tool_use", hasToolUses: true }, { outcome: "done", stopReason: "end_turn", hasToolUses: false }],
    tools: { outcome: "done" },
  });
  await runChatRun(step, sd, free);
  assert.deepEqual(calls.find(c => c.name === "llm-1").opts, { retries: { limit: 0 } });
  assert.deepEqual(calls.find(c => c.name === "tools-1").opts, { retries: { limit: 0 } });
});

test("the plan draft and approve-marker steps disable retries", async () => {
  const { step, calls } = makeStep({ events: { "plan_approval-0": { decision: "approve" } } });
  const { sd } = makeSd();
  await runChatRun(step, sd, plan);
  assert.deepEqual(calls.find(c => c.name === "draft_plan").opts, { retries: { limit: 0 } });
  assert.deepEqual(calls.find(c => c.name === "plan-approve-marker-0").opts, { retries: { limit: 0 } });
});

test("plan-confirmed: a cancel that wakes the plan wait ends aborted, not 'invalid decision'", async () => {
  const { step } = makeStep({ events: { "plan_approval-0": { decision: "__canceled__" } } });
  const { sd, ends } = makeSd({ cancelled: [false, true] });  // loop-top check false, post-wait check true
  assert.deepEqual(await runChatRun(step, sd, plan), { runId: "r1", outcome: "aborted" });
  assert.ok(ends.some(e => e.status === "aborted"), "settles aborted");
  assert.ok(!ends.some(e => e.status === "failed"), "must not fail on the wake decision");
});

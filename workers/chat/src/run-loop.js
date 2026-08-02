import { errMessage, isRedispatchError } from "./lib.js";

const MAX_TURNS = 128;
const MAX_PLAN_REVISE = 3;
const PLAN_APPROVAL_TIMEOUT = "5 minutes";

// ChatRunWorkflow body; step (Workflows engine) + sd (DO stub) injected so it's testable without cloudflare:workers.
export async function runChatRun(step, sd, { runId, mode }) {
  try {
    const startOutcome = await step.do("start", async () => sd.workflowStartRun({ runId }));
    if (startOutcome.skip) return { runId, outcome: "skipped", reason: startOutcome.reason };

    if (mode === "plan_confirmed") {
      return await runPlanConfirmed(step, sd, runId);
    }
    return await runFreeForm(step, sd, runId);
  } catch (err) {
    // A stale-claim / re-dispatch error = the engine is re-running under a fresh claim (prior
    // dispatch outlived its lease); that dispatch settles the run, so DON'T mark it failed here.
    // A genuine terminal failure settles the DO directly (step.do re-throws).
    if (!isRedispatchError(err)) {
      try {
        await sd.workflowEndRun({ runId, status: "failed", error: `workflow error: ${errMessage(err)}` });
      } catch {}
    }
    throw err;
  }
}

async function runFreeForm(step, sd, runId, options = {}) {
  const planContext = options.planContext ?? null;
  const endNamePrefix = options.endNamePrefix ?? "";

  let stopReason = null;
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const stepName = (prefix) => `${prefix}-${turn}`;

    if (await step.do(stepName("cancel-check"), async () => sd.workflowIsCancelled({ runId }))) {
      await step.do(`${endNamePrefix}end-aborted-${turn}`, async () => sd.workflowEndRun({ runId, status: "aborted" }));
      return { runId, outcome: "aborted" };
    }

    const llm = await step.do(
      stepName("llm"),
      { retries: { limit: 0 } },
      async () => sd.workflowExecuteLlmTurn({ runId, planContext }),
    );
    if (llm.outcome === "aborted") {
      await step.do(`${endNamePrefix}end-aborted-llm-${turn}`, async () => sd.workflowEndRun({ runId, status: "aborted" }));
      return { runId, outcome: "aborted" };
    }
    if (llm.outcome === "failed") {
      await step.do(`${endNamePrefix}end-failed-llm-${turn}`, async () => sd.workflowEndRun({ runId, status: "failed", error: llm.error ?? "llm failed" }));
      return { runId, outcome: "failed", error: llm.error ?? "llm failed" };
    }
    stopReason = llm.stopReason ?? null;

    // Content decides, not stop_reason: a turn cut short by the token cap (or by our own budget, then
    // salvaged) still carries finished tool calls, and ending the run there reports a half-done job as
    // success. The loop stops when the model has nothing left to run.
    if (!llm.hasToolUses) {
      // Strict false: a DO facet pinned to a version that predates this field omits it, and an
      // absent signal must keep the old behaviour rather than fail the run.
      if (llm.hasOutput === false) {
        // Whole turn spent thinking — no tool call, no text. A green "done" here is a silent failure.
        const error = "the model produced no answer this turn — please try again";
        await step.do(`${endNamePrefix}end-empty-${turn}`, async () => sd.workflowEndRun({ runId, status: "failed", error }));
        return { runId, outcome: "failed", error };
      }
      await step.do(`${endNamePrefix}end-done-${turn}`, async () => sd.workflowEndRun({ runId, status: "done", stopReason }));
      return { runId, outcome: "done", stopReason };
    }

    const tools = await step.do(
      stepName("tools"),
      { retries: { limit: 0 } },
      async () => sd.workflowRunToolBatch({ runId }),
    );
    if (tools.outcome === "aborted") {
      await step.do(`${endNamePrefix}end-aborted-tools-${turn}`, async () => sd.workflowEndRun({ runId, status: "aborted" }));
      return { runId, outcome: "aborted" };
    }
  }

  const err = `exceeded MAX_TURNS (${MAX_TURNS})`;
  await step.do(`${endNamePrefix}end-failed-max-turns`, async () => sd.workflowEndRun({ runId, status: "failed", error: err }));
  return { runId, outcome: "failed", error: err };
}

async function runPlanConfirmed(step, sd, runId) {
  let planText = null;
  let reviseNote = null;
  for (let attempt = 0; attempt <= MAX_PLAN_REVISE; attempt++) {
    if (await step.do(`plan-cancel-${attempt}`, async () => sd.workflowIsCancelled({ runId }))) {
      await step.do(`plan-end-aborted-${attempt}`, async () => sd.workflowEndRun({ runId, status: "aborted" }));
      return { runId, outcome: "aborted" };
    }

    const planRes = await step.do(
      attempt === 0 ? "draft_plan" : `revise_plan-${attempt}`,
      { retries: { limit: 0 } },
      async () => attempt === 0
        ? sd.workflowDraftPlan({ runId, attempt })
        : sd.workflowRevisePlan({ runId, note: reviseNote ?? "", attempt }),
    );
    if (planRes.outcome === "aborted") {
      await step.do(`plan-end-aborted-llm-${attempt}`, async () => sd.workflowEndRun({ runId, status: "aborted" }));
      return { runId, outcome: "aborted" };
    }
    if (planRes.outcome === "failed") {
      await step.do(`plan-end-failed-${attempt}`, async () => sd.workflowEndRun({ runId, status: "failed", error: planRes.error ?? "plan llm failed" }));
      return { runId, outcome: "failed", error: planRes.error ?? "plan llm failed" };
    }
    planText = planRes.plan ?? "";

    // waitForEvent returns the payload directly, or null on timeout.
    const event = await step.waitForEvent(`plan_approval-${attempt}`, {
      type: `plan_approval-${attempt}`,
      timeout: PLAN_APPROVAL_TIMEOUT,
    });
    if (event == null) {
      await step.do(`plan-end-timeout-${attempt}`, async () => sd.workflowEndRun({ runId, status: "aborted", error: "plan_approval timeout" }));
      return { runId, outcome: "aborted", reason: "plan_timeout" };
    }
    // A cancel/supersede woke the wait — abort cleanly rather than parse the wake event.
    if (await step.do(`plan-cancel-wait-${attempt}`, async () => sd.workflowIsCancelled({ runId }))) {
      await step.do(`plan-end-canceled-${attempt}`, async () => sd.workflowEndRun({ runId, status: "aborted" }));
      return { runId, outcome: "aborted" };
    }

    const decision = event.decision;
    const note = event.note;
    if (decision === "approve") {
      await step.do(`plan-approve-marker-${attempt}`, { retries: { limit: 0 } }, async () =>
        sd.workflowAfterPlanApprove({ runId }));
      break;
    }
    if (decision === "reject") {
      await step.do(`plan-end-rejected-${attempt}`, async () => sd.workflowEndRun({ runId, status: "aborted", error: "plan_rejected" }));
      return { runId, outcome: "aborted", reason: "plan_rejected" };
    }
    if (decision === "revise") {
      if (attempt >= MAX_PLAN_REVISE) {
        await step.do("plan-end-revise-exhausted", async () => sd.workflowEndRun({ runId, status: "aborted", error: "plan_revise_exhausted" }));
        return { runId, outcome: "aborted", reason: "plan_revise_exhausted" };
      }
      reviseNote = typeof note === "string" ? note : "";
      continue;
    }
    await step.do(`plan-end-invalid-${attempt}`, async () => sd.workflowEndRun({ runId, status: "failed", error: `invalid plan decision: ${decision}` }));
    return { runId, outcome: "failed", error: `invalid plan decision: ${decision}` };
  }

  return await runFreeForm(step, sd, runId, {
    planContext: planText,
    endNamePrefix: "exec-",
  });
}

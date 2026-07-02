// Pure run-state decisions for ChatSessionDO (testable without the DO/SQL).

const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "aborted"]);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

// Decide what a workflow "start" should do given the current run row:
//   { settleCancelled: true }              row.cancel_requested — caller settles aborted + skips
//   { skip: true, reason }                 no row, or an already-terminal row
//   { markRunning: false }                 idempotent resume of our own 'running' row (lost reply)
//   { markRunning: true }                  fresh 'pending' row — mark running, then proceed
export function decideStartRun(row) {
  if (!row) return { skip: true, reason: "run not found" };
  if (row.cancel_requested) return { settleCancelled: true };
  if (row.status === "running") return { markRunning: false };
  if (row.status !== "pending") return { skip: true, reason: `status=${row.status}` };
  return { markRunning: true };
}

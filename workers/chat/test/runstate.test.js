import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStartRun, isTerminalRunStatus } from "../src/runstate.js";

test("isTerminalRunStatus is true only for settled runs", () => {
  for (const s of ["done", "failed", "aborted"]) assert.equal(isTerminalRunStatus(s), true, s);
  for (const s of ["pending", "running", "", undefined]) assert.equal(isTerminalRunStatus(s), false, String(s));
});

test("decideStartRun: a missing row skips", () => {
  assert.deepEqual(decideStartRun(null), { skip: true, reason: "run not found" });
  assert.deepEqual(decideStartRun(undefined), { skip: true, reason: "run not found" });
});

test("decideStartRun: a cancel-requested row settles as cancelled (even if 'running')", () => {
  assert.deepEqual(decideStartRun({ status: "pending", cancel_requested: 1 }), { settleCancelled: true });
  assert.deepEqual(decideStartRun({ status: "running", cancel_requested: 1 }), { settleCancelled: true });
});

test("decideStartRun: a 'running' row resumes idempotently without re-marking (retried start)", () => {
  assert.deepEqual(decideStartRun({ status: "running", cancel_requested: 0 }), { markRunning: false });
});

test("decideStartRun: a terminal row skips with its status", () => {
  for (const s of ["done", "failed", "aborted"]) {
    assert.deepEqual(decideStartRun({ status: s, cancel_requested: 0 }), { skip: true, reason: `status=${s}` });
  }
});

test("decideStartRun: a fresh 'pending' row marks running and proceeds", () => {
  assert.deepEqual(decideStartRun({ status: "pending", cancel_requested: 0 }), { markRunning: true });
});

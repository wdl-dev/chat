import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToBase64,
  capText,
  extractText,
  httpError,
  isRedispatchError,
  jsonResponse,
  requireSecretEqual,
  safeUploadName,
  sseEvent,
  timingSafeStringEqual,
  toolResultBlock,
  uniqueUploadName,
} from "../src/lib.js";

test("toolResultBlock stringifies non-string output + coerces is_error", () => {
  assert.deepEqual(toolResultBlock("tu1", { ok: 1 }, false), {
    type: "tool_result", tool_use_id: "tu1", content: '{"ok":1}', is_error: false,
  });
  assert.deepEqual(toolResultBlock("tu2", "raw text", 1), {
    type: "tool_result", tool_use_id: "tu2", content: "raw text", is_error: true,
  });
});

test("extractText joins text blocks, ignores others, trims", () => {
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "tool_use", name: "x" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(extractText([{ type: "tool_result", content: "z" }]), "");
  assert.equal(extractText([{ type: "text", text: "  hi  " }]), "hi");
  assert.equal(extractText(null), "");
  assert.equal(extractText("not an array"), "");
});

test("jsonResponse stringifies and sets content-type", async () => {
  const r = jsonResponse(409, { error: "conflict" });
  assert.equal(r.status, 409);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(await r.text(), '{"error":"conflict"}');
});

test("httpError attaches status and extra", () => {
  const e = httpError(503, "no sandbox", { idx: 7 });
  assert.equal(e.status, 503);
  assert.equal(e.message, "no sandbox");
  assert.deepEqual(e.extra, { idx: 7 });
});

test("timingSafeStringEqual is correct, length-strict, and type-strict", () => {
  assert.equal(timingSafeStringEqual("ab", "ab"), true);
  assert.equal(timingSafeStringEqual("ab", "ac"), false);
  assert.equal(timingSafeStringEqual("ab", "abc"), false);
  assert.equal(timingSafeStringEqual(null, "ab"), false);
  assert.equal(timingSafeStringEqual(undefined, undefined), false);
});

test("requireSecretEqual 503s when expected is missing or empty", () => {
  for (const exp of [undefined, null, "", 0, false]) {
    assert.throws(
      () => requireSecretEqual("anything", exp, "MY_SECRET", "auth fail"),
      (err) => err.status === 503 && /MY_SECRET not configured/.test(err.message),
    );
  }
});

test("requireSecretEqual 401s 'incorrect' on mismatch, 'required' on empty presented", () => {
  assert.throws(
    () => requireSecretEqual("wrong", "right", "MY_SECRET", "token"),
    (err) => err.status === 401 && err.message === "token incorrect",
  );
  assert.throws(
    () => requireSecretEqual("", "right", "MY_SECRET", "token"),
    (err) => err.status === 401 && err.message === "token required",
  );
});

test("requireSecretEqual returns silently when presented matches expected", () => {
  assert.doesNotThrow(
    () => requireSecretEqual("right", "right", "MY_SECRET", "wrong token"),
  );
});

test("requireSecretEqual rejects empty presented + empty expected (the fail-open trap)", () => {
  // Naively timingSafeStringEqual("", "") returns true; the helper must
  // 503 on the empty expected before reaching the compare so a missing
  // secret never lets a no-header request through.
  assert.throws(
    () => requireSecretEqual("", "", "MY_SECRET", "wrong"),
    (err) => err.status === 503,
  );
});

test("sseEvent formats event + JSON data per SSE spec", () => {
  assert.equal(
    sseEvent("message.user", { seq: 0, content: "hi" }),
    'event: message.user\ndata: {"seq":0,"content":"hi"}\n\n',
  );
});

test("safeUploadName strips path components and traversal", () => {
  assert.equal(safeUploadName("../../etc/passwd"), "passwd");
  assert.equal(safeUploadName("a/b/c\\d.png"), "d.png");
  assert.equal(safeUploadName("...hidden"), "hidden");
  assert.equal(safeUploadName("résumé .pdf"), "r_sum__.pdf");
  assert.equal(safeUploadName(""), "file");
  assert.equal(safeUploadName(null), "file");
  assert.equal(safeUploadName("."), "file");
  assert.equal(safeUploadName("x".repeat(200)).length, 100);
});

test("uniqueUploadName suffixes -N only on collision, preserving the extension", () => {
  const used = new Set();
  assert.equal(uniqueUploadName("a.png", used), "a.png");
  used.add("a.png");
  assert.equal(uniqueUploadName("a.png", used), "a-2.png");
  used.add("a-2.png");
  assert.equal(uniqueUploadName("a.png", used), "a-3.png");
  assert.equal(uniqueUploadName("noext", new Set(["noext"])), "noext-2");
});

test("bytesToBase64 round-trips, including past the 0x8000 chunk boundary", () => {
  const small = new TextEncoder().encode("hello, 世界");
  assert.equal(bytesToBase64(small.buffer), Buffer.from(small).toString("base64"));
  const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256);
  assert.equal(bytesToBase64(big.buffer), Buffer.from(big).toString("base64"));
});

test("isRedispatchError matches the workflows-engine stale-claim errors, not real failures", () => {
  // Exact strings the platform throws (rust/workflows/src/api/{execution,identity}.rs).
  for (const m of [
    "Workflow run claim does not match instance state",
    "Workflow run claim lease has expired",
    "Workflow run claim lease is corrupt",
    "Workflow instance is not active",
    "Workflow ready token does not match instance state",
  ]) {
    assert.equal(isRedispatchError(new Error(m)), true, m);
  }
  // Survives wrapping (e.g. an HTTP envelope around the platform message).
  assert.equal(isRedispatchError(new Error("workflows 409: Workflow run claim does not match instance state")), true);
  // Genuine failures must still be settled as failed.
  for (const m of ["DeepSeek 500: overloaded", "llm failed", "exceeded MAX_TURNS (128)", "boom"]) {
    assert.equal(isRedispatchError(new Error(m)), false, m);
  }
  assert.equal(isRedispatchError(new TypeError("x is not a function")), false);
});

test("capText keeps head+tail with an elision marker when over the cap", () => {
  assert.equal(capText("short", 100), "short");
  const big = "H".repeat(200) + "T".repeat(200);
  const out = capText(big, 100);
  assert.ok(out.length < big.length, "shrinks oversized content");
  assert.ok(out.startsWith("H"), "keeps head");
  assert.ok(out.endsWith("T"), "keeps tail");
  assert.match(out, /truncated/);
});

test("toolResultBlock caps oversized content", () => {
  const huge = "x".repeat(300 * 1024);
  const block = toolResultBlock("t1", huge, false);
  assert.ok(block.content.length < huge.length, "capped");
  assert.match(block.content, /truncated/);
});

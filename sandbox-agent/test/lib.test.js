import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_EXCLUDES,
  SANDBOX_USER,
  WORKSPACE,
  appendCapped,
  buildChildEnv,
  exportFilename,
  makeCappedSink,
  makeKeyedRwLock,
  parseTimeoutSec,
  resolveWorkspacePath,
  sessionHomeDir,
  resolveReadablePath,
  sessionDir,
  validateSessionId,
} from "../lib.js";

const SID = "test-session";

test("validateSessionId accepts the documented alphabet", () => {
  assert.equal(validateSessionId("abc"), "abc");
  assert.equal(validateSessionId("ABC_123-xyz"), "ABC_123-xyz");
  assert.equal(validateSessionId("a"), "a");
  assert.equal(validateSessionId("a".repeat(64)), "a".repeat(64));
});

test("validateSessionId rejects empty, oversized, and bad chars", () => {
  assert.throws(() => validateSessionId(""), /sessionId must match/);
  assert.throws(() => validateSessionId("a".repeat(65)), /sessionId must match/);
  assert.throws(() => validateSessionId("has space"), /sessionId must match/);
  assert.throws(() => validateSessionId("has/slash"), /sessionId must match/);
  assert.throws(() => validateSessionId(".."), /sessionId must match/);
  assert.throws(() => validateSessionId(null), /sessionId must match/);
  assert.throws(() => validateSessionId(42), /sessionId must match/);
});

test("sessionDir produces /workspace/<sid>", () => {
  assert.equal(sessionDir(SID), `/workspace/${SID}`);
});

test("sessionHomeDir is a sibling of the project dir, not inside it", () => {
  assert.equal(sessionHomeDir(SID), `/workspace/${SID}.home`);
  // Must not be under the project dir, or `wdl init .` would see it.
  assert.ok(!sessionHomeDir(SID).startsWith(`${sessionDir(SID)}/`));
});

test("SANDBOX_USER is the single non-root sandbox uid", () => {
  assert.deepEqual(SANDBOX_USER, { uid: 2000, name: "sandbox" });
});

test("resolveWorkspacePath canonicalizes paths inside /workspace/<sid>", () => {
  const root = `/workspace/${SID}`;
  assert.deepEqual(resolveWorkspacePath("/workspace/foo.js", SID),
    { abs: `${root}/foo.js`, presented: "/workspace/foo.js", root });
  assert.deepEqual(resolveWorkspacePath("foo.js", SID),
    { abs: `${root}/foo.js`, presented: "/workspace/foo.js", root });
  assert.deepEqual(resolveWorkspacePath("a/b/c.js", SID),
    { abs: `${root}/a/b/c.js`, presented: "/workspace/a/b/c.js", root });
  assert.deepEqual(resolveWorkspacePath("/workspace", SID),
    { abs: root, presented: WORKSPACE, root });
});

test("resolveWorkspacePath rejects traversal and absolute escapes", () => {
  assert.throws(() => resolveWorkspacePath("/etc/passwd", SID), /escapes/);
  assert.throws(() => resolveWorkspacePath("../etc/passwd", SID), /escapes/);
  assert.throws(() => resolveWorkspacePath("/workspace/../etc/passwd", SID), /escapes/);
  assert.throws(() => resolveWorkspacePath("/workspace/sub/../../etc", SID), /escapes/);
  assert.throws(() => resolveWorkspacePath("/workspace/foo/../../bar", SID), /escapes/);
});

test("resolveReadablePath allows the bundled docs + examples read-only", () => {
  assert.deepEqual(resolveReadablePath("/opt/wdl-cli/docs/assets.md", SID),
    { abs: "/opt/wdl-cli/docs/assets.md", presented: "/opt/wdl-cli/docs/assets.md", root: "/opt/wdl-cli/docs" });
  assert.deepEqual(resolveReadablePath("/opt/wdl-cli/examples/showcase/src/index.js", SID),
    { abs: "/opt/wdl-cli/examples/showcase/src/index.js", presented: "/opt/wdl-cli/examples/showcase/src/index.js", root: "/opt/wdl-cli/examples" });
});

test("resolveReadablePath still routes workspace paths through the workspace gate", () => {
  assert.deepEqual(resolveReadablePath("foo.js", SID),
    { abs: `/workspace/${SID}/foo.js`, presented: "/workspace/foo.js", root: `/workspace/${SID}` });
});

test("resolveReadablePath blocks other absolute paths and allowlist traversal", () => {
  assert.throws(() => resolveReadablePath("/etc/passwd", SID), /escapes/);
  assert.throws(() => resolveReadablePath("/opt/secrets", SID), /escapes/);
  assert.throws(() => resolveReadablePath("/opt/wdl-cli/lib/pack.js", SID), /escapes/);
  assert.throws(() => resolveReadablePath("/opt/wdl-cli/docs/../../etc/passwd", SID), /escapes/);
});

test("resolveWorkspacePath rejects empty / non-string", () => {
  assert.throws(() => resolveWorkspacePath("", SID), /path required/);
  assert.throws(() => resolveWorkspacePath(null, SID), /path required/);
  assert.throws(() => resolveWorkspacePath(undefined, SID), /path required/);
  assert.throws(() => resolveWorkspacePath(42, SID), /path required/);
});

test("resolveWorkspacePath rejects invalid sessionId", () => {
  assert.throws(() => resolveWorkspacePath("foo.js", ""), /sessionId must match/);
  assert.throws(() => resolveWorkspacePath("foo.js", "../escape"), /sessionId must match/);
});

test("appendCapped truncates at cap and reports a sticky flag", () => {
  assert.deepEqual(appendCapped("ab", "cd", 10), { value: "abcd", truncated: false });
  assert.deepEqual(appendCapped("ab", "cd", 3),  { value: "abc",  truncated: true });
  assert.deepEqual(appendCapped("ab", "cd", 2),  { value: "ab",   truncated: true });
  assert.deepEqual(appendCapped("ab", "cd", 0),  { value: "ab",   truncated: true });
});

test("buildChildEnv whitelists PATH, sets per-session HOME + wrangler metrics off", () => {
  const env = buildChildEnv(
    { WDL_NS: "tmp-1" },
    { PATH: "/usr/bin", ADMIN_TOKEN: "must-not-leak", HOME: "/root" },
    "/workspace/abc",
  );
  assert.deepEqual(env, {
    HOME: "/workspace/abc",
    NODE_ENV: "development",
    NO_UPDATE_NOTIFIER: "1",
    PATH: "/usr/bin",
    WDL_NS: "tmp-1",
    WDL_WRANGLER_BIN: "/opt/sandbox-agent/scripts/wrangler-shim.mjs",
    WRANGLER_SEND_METRICS: "false",
  });
});

test("buildChildEnv points WDL_WRANGLER_BIN at the wrangler shim", () => {
  const env = buildChildEnv(
    {},
    { PATH: "/usr/bin", WDL_CLI_LOCAL_PATH: "/opt/wdl-cli" },
    "/workspace/abc",
  );
  assert.equal(env.WDL_WRANGLER_BIN, "/opt/sandbox-agent/scripts/wrangler-shim.mjs");
});

test("buildChildEnv refuses to let caller override system keys via extra", () => {
  const env = buildChildEnv(
    {
      HOME: "/etc",
      NODE_ENV: "production",
      WRANGLER_SEND_METRICS: "true",
      MY_OK_KEY: "kept",
    },
    { PATH: "/usr/bin" },
    "/workspace/sid",
  );
  assert.equal(env.HOME, "/workspace/sid");
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  assert.equal(env.MY_OK_KEY, "kept");
});

test("buildChildEnv default homeDir is /workspace", () => {
  const env = buildChildEnv({}, { PATH: "/usr/bin" });
  assert.equal(env.HOME, WORKSPACE);
});

test("buildChildEnv passes WDL_CLI_LOCAL_PATH through (wdl init reads it)", () => {
  const env = buildChildEnv(
    {},
    { PATH: "/usr/bin", WDL_CLI_LOCAL_PATH: "/opt/wdl-cli" },
    "/workspace/x",
  );
  assert.equal(env.WDL_CLI_LOCAL_PATH, "/opt/wdl-cli");
});

test("buildChildEnv ignores non-string extras and missing PATH", () => {
  const env = buildChildEnv({ A: "ok", B: 1, C: null, D: undefined }, {}, "/workspace/x");
  assert.equal(env.A, "ok");
  assert.equal(env.B, undefined);
  assert.equal(env.C, undefined);
  assert.equal(env.D, undefined);
  assert.equal(env.PATH, undefined);
});

test("buildChildEnv tolerates non-object extras", () => {
  for (const extra of [null, undefined, [], "str", 7]) {
    const env = buildChildEnv(extra, { PATH: "/usr/bin" }, "/workspace/y");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/workspace/y");
    assert.equal(env.WRANGLER_SEND_METRICS, "false");
  }
});

test("parseTimeoutSec rejects out-of-range, accepts numeric strings", () => {
  assert.equal(parseTimeoutSec(undefined, 60), 60);
  assert.equal(parseTimeoutSec(null, 60), 60);
  assert.equal(parseTimeoutSec(15, 60), 15);
  assert.equal(parseTimeoutSec("15", 60), 15);
  assert.equal(parseTimeoutSec(600, 60), 600);
  assert.throws(() => parseTimeoutSec(0, 60),    /must be 1\.\.600/);
  assert.throws(() => parseTimeoutSec(-1, 60),   /must be 1\.\.600/);
  assert.throws(() => parseTimeoutSec(601, 60),  /must be 1\.\.600/);
  assert.throws(() => parseTimeoutSec("abc", 60),/must be 1\.\.600/);
  assert.throws(() => parseTimeoutSec(NaN, 60),  /must be 1\.\.600/);
});

const tick = () => new Promise(r => setTimeout(r, 5));

test("makeKeyedRwLock runs reads concurrently for the same key", async () => {
  const lock = makeKeyedRwLock();
  let active = 0, maxActive = 0;
  const reader = () => lock.read("k", async () => {
    active++; maxActive = Math.max(maxActive, active);
    await tick();
    active--;
  });
  await Promise.all([reader(), reader(), reader()]);
  assert.equal(maxActive, 3); // all three overlapped
});

test("makeKeyedRwLock write excludes reads and other writes", async () => {
  const lock = makeKeyedRwLock();
  const order = [];
  // a read in flight; a write must wait for it, then a read waits for the write
  const r1 = lock.read("k", async () => { order.push("r1-start"); await tick(); order.push("r1-end"); });
  const w = lock.write("k", async () => { order.push("w-start"); await tick(); order.push("w-end"); });
  const r2 = lock.read("k", async () => { order.push("r2"); });
  await Promise.all([r1, w, r2]);
  // r1 fully completes before w starts; r2 only after w ends
  assert.ok(order.indexOf("r1-end") < order.indexOf("w-start"), order.join(","));
  assert.ok(order.indexOf("w-end") < order.indexOf("r2"), order.join(","));
});

test("makeKeyedRwLock serializes writes FIFO", async () => {
  const lock = makeKeyedRwLock();
  const order = [];
  const w = (n) => lock.write("k", async () => { order.push(`${n}-s`); await tick(); order.push(`${n}-e`); });
  await Promise.all([w(1), w(2), w(3)]);
  assert.deepEqual(order, ["1-s", "1-e", "2-s", "2-e", "3-s", "3-e"]);
});

test("makeKeyedRwLock does not starve a queued writer behind later reads", async () => {
  const lock = makeKeyedRwLock();
  const order = [];
  const r1 = lock.read("k", async () => { order.push("r1-s"); await tick(); order.push("r1-e"); });
  const w = lock.write("k", async () => { order.push("w"); });
  const r2 = lock.read("k", async () => { order.push("r2"); }); // queued after w
  await Promise.all([r1, w, r2]);
  // w runs after r1 but before r2 (r2 waited for the queued writer)
  assert.ok(order.indexOf("w") < order.indexOf("r2"), order.join(","));
});

test("makeKeyedRwLock reads on different keys are independent", async () => {
  const lock = makeKeyedRwLock();
  const order = [];
  // a write on k1 must not block a read on k2
  const w = lock.write("k1", async () => { order.push("w-s"); await tick(); order.push("w-e"); });
  const r = lock.read("k2", async () => { order.push("r"); });
  await Promise.all([w, r]);
  assert.ok(order.indexOf("r") < order.indexOf("w-e"), order.join(","));
});

test("makeKeyedRwLock times out a read waiting on a stuck writer", async () => {
  const lock = makeKeyedRwLock(20);
  let releaseW;
  const w = lock.write("k", () => new Promise(r => { releaseW = r; })); // never resolves until we release
  await assert.rejects(lock.read("k", async () => {}), /sandbox busy/);
  releaseW();
  await w;
});

test("makeKeyedRwLock evicts the key entry when idle (no map leak)", async () => {
  const lock = makeKeyedRwLock();
  await lock.write("k", async () => {});
  await lock.read("k", async () => {});
  // a fresh write after full drain should still be immediate (entry recreated)
  let ran = false;
  await lock.write("k", async () => { ran = true; });
  assert.equal(ran, true);
});

test("makeKeyedRwLock: a failed read does not block later ops", async () => {
  const lock = makeKeyedRwLock();
  await assert.rejects(lock.read("k", async () => { throw new Error("boom"); }), /boom/);
  let ran = false;
  await lock.write("k", async () => { ran = true; });
  assert.equal(ran, true);
});

test("makeKeyedRwLock: a timed-out queued writer never releases the lock early", async () => {
  // W2 times out waiting on W1; its release must stay chained behind W1 so a
  // writer queued behind W2 cannot run while W1 still holds the lock.
  const lock = makeKeyedRwLock(20);
  let active = 0, maxActive = 0;
  const hold = (ms) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, ms));
    active--;
  };
  const results = await Promise.allSettled([
    lock.write("k", hold(120)),  // holds well past the 20ms acquire timeout
    lock.write("k", hold(120)),
    lock.write("k", hold(120)),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(maxActive, 1); // exclusion held despite the timeouts
});

test("exportFilename sanitizes the ns so it can't inject Content-Disposition syntax", () => {
  assert.equal(exportFilename("tmp-b58a9ddf"), "tmp-b58a9ddf-workspace.tar.gz");
  // strips quotes / CRLF / path separators that would break out of the header value
  assert.equal(exportFilename('a"; rm -rf /\r\nX'), "arm-rfX-workspace.tar.gz");
  assert.equal(exportFilename("../../etc"), "etc-workspace.tar.gz");
  assert.equal(exportFilename(""), "workspace-workspace.tar.gz");
  assert.equal(exportFilename(null), "workspace-workspace.tar.gz");
});

test("makeCappedSink accumulates chunks and reports a sticky truncation at the cap", () => {
  const s = makeCappedSink(5);
  s.onData(Buffer.from("ab"));
  assert.equal(s.value, "ab");
  assert.equal(s.truncated, false);
  s.onData(Buffer.from("cdef"));      // ab + cdef -> capped to "abcde"
  assert.equal(s.value, "abcde");
  assert.equal(s.truncated, true);
  s.onData(Buffer.from("x"));         // stays capped; truncated stays set
  assert.equal(s.value, "abcde");
  assert.equal(s.truncated, true);
});

test("makeCappedSink stream-decodes a multibyte char split across chunks", () => {
  const s = makeCappedSink(1000);
  s.onData(Buffer.from([0xE4, 0xB8]));  // first two bytes of 中 (E4 B8 AD)
  s.onData(Buffer.from([0xAD]));         // final byte
  assert.equal(s.value, "中");
  assert.equal(s.truncated, false);
});

test("EXPORT_EXCLUDES drops secret files at any depth from a tar export", () => {
  const dir = mkdtempSync(join(tmpdir(), "wdl-exc-"));
  try {
    for (const d of ["sub", "apps/web"]) mkdirSync(join(dir, d), { recursive: true });
    const secrets = [".env", ".env.local", ".dev.vars", ".dev.vars.prod", "sub/.env", "sub/.dev.vars", "apps/web/.env.local"];
    const keep = [".envrc", "keep.txt", "sub/app.js", "apps/web/index.js"]; // .envrc is not a secret
    for (const p of [...secrets, ...keep]) writeFileSync(join(dir, p), "x");
    const out = `${dir}.tgz`; // outside the archived dir so tar doesn't see it change
    execFileSync("tar", ["-czf", out, "-C", dir, ...EXPORT_EXCLUDES.map(e => `--exclude=${e}`), "."]);
    const names = execFileSync("tar", ["-tzf", out], { encoding: "utf8" })
      .split("\n").filter(Boolean).map(s => s.replace(/\/$/, ""));
    for (const p of secrets) assert.ok(!names.includes(`./${p}`), `secret leaked into export: ${p}`);
    for (const p of keep) assert.ok(names.includes(`./${p}`), `legit file dropped from export: ${p}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.tgz`, { force: true });
  }
});

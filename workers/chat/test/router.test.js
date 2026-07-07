import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/router.js";

// Minimal env: a D1 stub returning a fixed sessions_index row, a DO stub, and
// a workflow stub. Override sessionRow / do per test.
function makeEnv({ sessionRow = { id: "s1", ns: "s1", status: "active", created_at: Date.now() }, do: doOver = {}, runExists = true, runAttempt = "0" } = {}) {
  const doStub = {
    init: async () => ({ ok: true }),
    addUserMessage: async () => ({ runId: "r1", seq: 1, mode: "free_form" }),
    cancelLatestRun: async () => ({ ok: true, runId: "r1" }),
    runBelongsToSession: async () => ({ exists: runExists, attempt: runAttempt }),
    requestClose: async () => {},
    expire: async () => ({ ok: true }),
    fetch: async () => new Response("ok", { status: 200 }),
    ...doOver,
  };
  return {
    DEMO_PASSCODE: "pass-123",
    OPERATOR_TOKEN: "op-123",
    ADMIN_URL: "https://api",
    TOKEN_ISSUER_TOKEN: "tok",
    CHAT_DB: {
      prepare: () => ({ bind: () => ({ first: async () => sessionRow, run: async () => ({}) }) }),
    },
    CHAT_SESSION_DO: { idFromName: (n) => n, get: () => doStub },
    CHAT_RUN: { get: async () => ({ sendEvent: async () => {} }) },
  };
}

function req(method, path, { json, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["content-type"] = "application/json";
  }
  return new Request(`https://chat.local${path}`, init);
}

const body = (res) => res.json();

test("unknown route -> 404 not found", async () => {
  const res = await handleRequest(req("GET", "/nope"), makeEnv());
  assert.equal(res.status, 404);
  assert.deepEqual(await body(res), { error: "not found" });
});

test("portal/start rejects a wrong passcode with 401 (before minting anything)", async () => {
  const res = await handleRequest(req("POST", "/portal/start", { json: { passcode: "wrong" } }), makeEnv());
  assert.equal(res.status, 401);
  assert.equal((await body(res)).error, "passcode incorrect");
});

test("portal/start 401s 'passcode required' when none is presented", async () => {
  const res = await handleRequest(req("POST", "/portal/start", { json: {} }), makeEnv());
  assert.equal(res.status, 401);
  assert.equal((await body(res)).error, "passcode required");
});

test("POST messages requires non-empty content", async () => {
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: {} }), makeEnv());
  assert.equal(res.status, 400);
  assert.equal((await body(res)).error, "content required");
});

test("POST messages enforces the size cap", async () => {
  const res = await handleRequest(
    req("POST", "/sessions/s1/messages", { json: { content: "x".repeat(50_001) } }),
    makeEnv(),
  );
  assert.equal(res.status, 413);
});

test("POST messages 404s when the session is not active", async () => {
  for (const sessionRow of [null, { id: "s1", ns: "s1", status: "closed" }]) {
    const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), makeEnv({ sessionRow }));
    assert.equal(res.status, 404, JSON.stringify(sessionRow));
    assert.equal((await body(res)).error, "session not active");
  }
});

test("POST messages on an active session returns 202 with the run handle", async () => {
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), makeEnv());
  assert.equal(res.status, 202);
  assert.deepEqual(await body(res), { runId: "r1", seq: 1, mode: "free_form" });
});

test("approve-plan validates the decision and runId", async () => {
  const bad = await handleRequest(req("POST", "/sessions/s1/approve-plan", { json: { decision: "maybe", runId: "r1" } }), makeEnv());
  assert.equal(bad.status, 400);
  const noRun = await handleRequest(req("POST", "/sessions/s1/approve-plan", { json: { decision: "approve" } }), makeEnv());
  assert.equal(noRun.status, 400);
  assert.equal((await body(noRun)).error, "runId required");
});

test("approve-plan rejects a runId that doesn't belong to the session", async () => {
  const res = await handleRequest(
    req("POST", "/sessions/s1/approve-plan", { json: { decision: "approve", runId: "r-other" } }),
    makeEnv({ runExists: false }),
  );
  assert.equal(res.status, 404);
  assert.equal((await body(res)).error, "run not found for session");
});

test("admin force-close requires the operator token", async () => {
  const denied = await handleRequest(req("POST", "/admin/sessions/s1/force-close"), makeEnv());
  assert.equal(denied.status, 401);
  const ok = await handleRequest(req("POST", "/admin/sessions/s1/force-close", { headers: { "x-operator-token": "op-123" } }), makeEnv());
  assert.equal(ok.status, 200);
  assert.deepEqual(await body(ok), { ok: true, sessionId: "s1" });
});

test("the error envelope surfaces only clientMessage, never an internal error", async () => {
  const env = makeEnv({ do: { addUserMessage: async () => { throw new Error("DB password is hunter2"); } } });
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), env);
  assert.equal(res.status, 500);
  assert.deepEqual(await body(res), { error: "internal error" });
});

// A mintDelegatedNs response for /portal/start (handleRequest's 3rd arg = fetcher).
const fakeMint = () => async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ token: "ns-tok", ns: "tmp-xyz", tokenId: "tid-1" }); } });

test("GET /stream and /export 404 on a closed session (not replayable by id)", async () => {
  for (const sub of ["stream", "export"]) {
    const res = await handleRequest(req("GET", `/sessions/s1/${sub}`), makeEnv({ sessionRow: { id: "s1", ns: "s1", status: "closed" } }));
    assert.equal(res.status, 404, sub);
    assert.equal((await body(res)).error, "session closed");
  }
});

test("GET /stream forwards to the DO on an active session", async () => {
  let path = null;
  const env = makeEnv({ do: { fetch: async (r) => { path = new URL(r.url).pathname; return new Response("streamed", { status: 200 }); } } });
  const res = await handleRequest(req("GET", "/sessions/s1/stream"), env);
  assert.equal(res.status, 200);
  assert.equal(path, "/stream");
});

test("POST /close is idempotent on an already-closed session", async () => {
  const res = await handleRequest(req("POST", "/sessions/s1/close"), makeEnv({ sessionRow: { id: "s1", ns: "s1", status: "closed" } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true, alreadyClosed: true });
});

test("POST /close closes an active session", async () => {
  const res = await handleRequest(req("POST", "/sessions/s1/close"), makeEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
});

test("POST /cancel cancels the latest run", async () => {
  const res = await handleRequest(req("POST", "/sessions/s1/cancel"), makeEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true, runId: "r1" });
});

// One D1 mock for the lazy-expiry tests; createdAt drives the time gate, flags record the teardown.
function dbEnv({ createdAt, do: doOver = {} } = {}) {
  const flags = { expired: false, closed: false, closedInDb: false };
  const env = makeEnv({ do: {
    expire: async () => { flags.expired = true; return { ok: true }; },
    requestClose: async () => { flags.closed = true; return { ok: true }; },
    ...doOver,
  } });
  env.CHAT_DB = { prepare: (sql) => ({ bind: () => ({
    first: async () => ({ id: "s1", ns: "s1", status: "active", created_at: createdAt }),
    run: async () => { if (/status = 'closed'/.test(sql)) flags.closedInDb = true; return {}; },
  }) }) };
  return { env, flags };
}

test("POST messages on an expired session lazily terminates it (410 + catalog closed + DO expire)", async () => {
  const { env, flags } = dbEnv({ createdAt: 0 });
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), env);
  assert.equal(res.status, 410);
  assert.equal((await body(res)).error, "session expired");
  assert.ok(flags.expired, "DO expire() called");
  assert.ok(flags.closedInDb, "sessions_index marked closed");
});

test("GET stream on an expired session tears it down and 404s (never forwards to the DO)", async () => {
  const { env, flags } = dbEnv({ createdAt: 0, do: { fetch: async () => new Response("should-not-reach", { status: 200 }) } });
  const res = await handleRequest(req("GET", "/sessions/s1/stream"), env);
  assert.equal(res.status, 404);
  assert.equal((await body(res)).error, "session closed");
  assert.ok(flags.expired, "DO expire() called on stream access");
  assert.ok(flags.closedInDb, "sessions_index marked closed");
});

test("a fresh (non-expired) active session is not torn down", async () => {
  const { env, flags } = dbEnv({ createdAt: Date.now() });
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), env);
  assert.equal(res.status, 202);
  assert.ok(!flags.expired, "fresh session must not be expired");
});

test("a legacy row without created_at never trips the time gate", async () => {
  const { env, flags } = dbEnv({ createdAt: undefined });
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), env);
  assert.equal(res.status, 202);
  assert.ok(!flags.expired);
});

test("expiry still fences the catalog when DO expire() is missing, via the requestClose fallback", async () => {
  const { env, flags } = dbEnv({ createdAt: 0, do: { expire: async () => { throw new Error("no such method"); } } });
  const res = await handleRequest(req("POST", "/sessions/s1/messages", { json: { content: "hi" } }), env);
  assert.equal(res.status, 410);
  assert.ok(flags.closed, "fell back to requestClose()");
  assert.ok(flags.closedInDb, "catalog fenced even though expire() threw");
});

test("POST /upload rejects an oversized body via content-length", async () => {
  const res = await handleRequest(req("POST", "/sessions/s1/upload", { headers: { "content-length": String(20 * 1024 * 1024) } }), makeEnv());
  assert.equal(res.status, 413);
});

test("approve-plan forwards the plan_approval event on the happy path", async () => {
  const events = [];
  const env = makeEnv();
  env.CHAT_RUN = { get: async () => ({ sendEvent: async (e) => { events.push(e); } }) };
  const res = await handleRequest(req("POST", "/sessions/s1/approve-plan", { json: { decision: "approve", runId: "r-mine" } }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "plan_approval-0");  // default attempt 0
  assert.equal(events[0].payload.decision, "approve");

  // the SERVER's await attempt is used; a client-echoed attempt is ignored
  const events2 = [];
  const env2 = makeEnv({ runAttempt: "1" });
  env2.CHAT_RUN = { get: async () => ({ sendEvent: async (e) => { events2.push(e); } }) };
  await handleRequest(req("POST", "/sessions/s1/approve-plan", { json: { decision: "revise", runId: "r-mine", note: "x", attempt: 2 } }), env2);
  assert.equal(events2[0].type, "plan_approval-1");  // server attempt, not the client's 2
});

test("portal/start mints a session with a random id decoupled from the public ns", async () => {
  const before = Date.now();
  const res = await handleRequest(req("POST", "/portal/start", { json: { passcode: "pass-123", lang: "zh" } }), makeEnv(), fakeMint());
  assert.equal(res.status, 200);
  const out = await body(res);
  assert.equal(out.ns, "tmp-xyz");
  assert.match(out.sessionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(out.sessionId, out.ns);  // bearer id must not equal the published ns
  // expiresAt = the moment the lazy-expiry gate starts refusing (TTL minus margin), for the client countdown
  const sixHoursLessMargin = 6 * 60 * 60_000 - 5 * 60_000;
  assert.ok(out.expiresAt >= before + sixHoursLessMargin && out.expiresAt <= Date.now() + sixHoursLessMargin);
});

test("portal/start hands the DO the same expiresAt it returns to the client", async () => {
  let got = null;
  const env = makeEnv({ do: { init: async (a) => { got = a; return { ok: true }; } } });
  const res = await handleRequest(req("POST", "/portal/start", { json: { passcode: "pass-123" } }), env, fakeMint());
  const out = await body(res);
  assert.ok(Number.isFinite(got.expiresAt));
  assert.equal(got.expiresAt, out.expiresAt);
});

test("portal/start rolls back the session index when DO init fails", async () => {
  let closed = false;
  const env = makeEnv({ do: { init: async () => { throw new Error("init boom"); } } });
  env.CHAT_DB = { prepare: (sql) => ({ bind: () => ({ first: async () => null, run: async () => { if (/status = 'closed'/.test(sql)) closed = true; return {}; } }) }) };
  const res = await handleRequest(req("POST", "/portal/start", { json: { passcode: "pass-123" } }), env, fakeMint());
  assert.equal(res.status, 502);
  assert.equal(closed, true, "must mark the session closed on init failure");
});

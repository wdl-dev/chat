import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeMicrovm,
  isMicrovmNotFound,
  mintAuthToken,
  openMicrovm,
  parseAuthToken,
} from "../src/lib.js";

const ENV = {
  MICROVM_IMAGE_ARN: "arn:image",
  INGRESS_CONNECTOR_ARN: "arn:in",
  EGRESS_CONNECTOR_ARN: "arn:eg",
};

// Records every AWS call; `respond(method, pathPart, body, i)` returns the
// parsed response (or an Error instance to throw, mirroring #aws on non-2xx).
function makeAws(respond) {
  const calls = [];
  const aws = async (method, pathPart, body) => {
    calls.push({ method, pathPart, body });
    const r = respond(method, pathPart, body, calls.length - 1);
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  return { aws, calls };
}

const noSleep = () => Promise.resolve();
const fixedNow = () => 1000;

function deps(aws, initSession = async () => {}) {
  return { aws, initSession, env: ENV, sleep: noSleep, now: fixedNow };
}

test("parseAuthToken unwraps the X-aws-proxy-auth envelope or a bare string", () => {
  assert.equal(parseAuthToken({ authToken: { "X-aws-proxy-auth": "jwe" } }), "jwe");
  assert.equal(parseAuthToken({ authToken: "jwe" }), "jwe");
  assert.throws(() => parseAuthToken({ authToken: { other: "x" } }), /missing X-aws-proxy-auth/);
  assert.throws(() => parseAuthToken({}), /missing X-aws-proxy-auth/);
});

test("isMicrovmNotFound matches the status marker, not a body 404", () => {
  assert.equal(isMicrovmNotFound(new Error("lambda-microvms DELETE /x -> 404: gone")), true);
  assert.equal(isMicrovmNotFound(new Error('-> 500: {"code":"404 elsewhere"}')), false);
  assert.equal(isMicrovmNotFound(undefined), false);
});

test("mintAuthToken posts the right shape and stamps expiry from now()", async () => {
  const { aws, calls } = makeAws(() => ({ authToken: { "X-aws-proxy-auth": "jwe" } }));
  const out = await mintAuthToken(aws, "vm-1", fixedNow);
  assert.deepEqual(out, { authToken: "jwe", expiresAt: 1000 + 30 * 60_000 });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].pathPart, "/2025-09-09/microvms/vm-1/auth-token");
  assert.equal(calls[0].body.expirationInMinutes, 30);
  assert.deepEqual(calls[0].body.allowedPorts, [{ port: 8080 }]);
});

test("closeMicrovm is a no-op without an id", async () => {
  const { aws, calls } = makeAws(() => ({}));
  assert.deepEqual(await closeMicrovm(aws, ""), { ok: true });
  assert.equal(calls.length, 0);
});

test("closeMicrovm deletes by id and swallows a 404", async () => {
  const ok = makeAws((m, p) => { assert.equal(m, "DELETE"); assert.equal(p, "/2025-09-09/microvms/vm-1"); return {}; });
  assert.deepEqual(await closeMicrovm(ok.aws, "vm-1"), { ok: true });
  assert.equal(ok.calls.length, 1);

  const gone = makeAws(() => new Error("lambda-microvms DELETE /x -> 404: gone"));
  assert.deepEqual(await closeMicrovm(gone.aws, "vm-1"), { ok: true });
});

test("closeMicrovm rethrows a non-404 failure", async () => {
  const { aws } = makeAws(() => new Error("lambda-microvms DELETE /x -> 500: boom"));
  await assert.rejects(() => closeMicrovm(aws, "vm-1"), /500: boom/);
});

test("openMicrovm requires a sessionId", async () => {
  const { aws, calls } = makeAws(() => ({}));
  await assert.rejects(() => openMicrovm(deps(aws), { sessionId: "" }), /sessionId required/);
  assert.equal(calls.length, 0);
});

test("openMicrovm: create RUNNING -> mint -> init returns the session handle", async () => {
  const { aws, calls } = makeAws((method, pathPart) => {
    if (method === "POST" && pathPart === "/2025-09-09/microvms") {
      return { microvmId: "vm-1", state: "RUNNING", endpoint: "ep-1" };
    }
    if (pathPart.endsWith("/auth-token")) return { authToken: { "X-aws-proxy-auth": "jwe-1" } };
    return {};
  });
  const inits = [];
  const out = await openMicrovm(
    deps(aws, async (endpoint, authToken, init) => { inits.push({ endpoint, authToken, init }); }),
    { sessionId: "sess-1", ns: "tmp-1", adminUrl: "https://api", nsToken: "ns-tok" },
  );
  assert.deepEqual(out, { microvmId: "vm-1", endpoint: "ep-1", authToken: "jwe-1", authTokenExpiresAt: 1000 + 30 * 60_000 });
  // The create call carries the lifecycle policy.
  const create = calls[0].body;
  assert.equal(create.imageIdentifier, "arn:image");
  assert.equal(create.maximumDurationInSeconds, 2 * 60 * 60);
  assert.equal(create.idlePolicy.maxIdleDurationSeconds, 10 * 60);
  assert.equal(create.idlePolicy.suspendedDurationSeconds, 30 * 60);
  // /init got the session context.
  assert.deepEqual(inits[0].init, { sessionId: "sess-1", ns: "tmp-1", adminUrl: "https://api", nsToken: "ns-tok" });
  assert.equal(inits[0].authToken, "jwe-1");
});

test("openMicrovm polls a PENDING create until RUNNING", async () => {
  const { aws, calls } = makeAws((method, pathPart) => {
    if (method === "POST" && pathPart === "/2025-09-09/microvms") return { microvmId: "vm-2", state: "PENDING" };
    if (method === "GET") return { state: "RUNNING", endpoint: "ep-2" };
    if (pathPart.endsWith("/auth-token")) return { authToken: { "X-aws-proxy-auth": "jwe-2" } };
    return {};
  });
  const out = await openMicrovm(deps(aws), { sessionId: "sess-2" });
  assert.equal(out.microvmId, "vm-2");
  assert.equal(out.endpoint, "ep-2");
  assert.ok(calls.some(c => c.method === "GET"), "should have polled at least once");
});

test("openMicrovm terminates the VM when it reports a terminal state (no orphan)", async () => {
  const { aws, calls } = makeAws((method, pathPart) => {
    if (method === "POST" && pathPart === "/2025-09-09/microvms") return { microvmId: "vm-3", state: "FAILED", stateReason: "boom" };
    return {};
  });
  await assert.rejects(() => openMicrovm(deps(aws), { sessionId: "sess-3" }), /vm-3 FAILED/);
  assert.ok(calls.some(c => c.method === "DELETE" && c.pathPart === "/2025-09-09/microvms/vm-3"), "must terminate the failed VM");
});

test("openMicrovm terminates the VM when /init fails (no orphan)", async () => {
  const { aws, calls } = makeAws((method, pathPart) => {
    if (method === "POST" && pathPart === "/2025-09-09/microvms") return { microvmId: "vm-4", state: "RUNNING", endpoint: "ep-4" };
    if (pathPart.endsWith("/auth-token")) return { authToken: { "X-aws-proxy-auth": "jwe-4" } };
    return {};
  });
  await assert.rejects(
    () => openMicrovm(deps(aws, async () => { throw new Error("init boom"); }), { sessionId: "sess-4" }),
    /init boom/,
  );
  assert.ok(calls.some(c => c.method === "DELETE" && c.pathPart === "/2025-09-09/microvms/vm-4"), "must terminate after init failure");
});

test("openMicrovm terminates the VM when it never reaches RUNNING", async () => {
  const { aws, calls } = makeAws((method, pathPart) => {
    if (method === "POST" && pathPart === "/2025-09-09/microvms") return { microvmId: "vm-5", state: "PENDING" };
    if (method === "GET") return { state: "PENDING" };
    return {};
  });
  await assert.rejects(() => openMicrovm(deps(aws), { sessionId: "sess-5" }), /not RUNNING after poll/);
  assert.ok(calls.some(c => c.method === "DELETE" && c.pathPart === "/2025-09-09/microvms/vm-5"), "must terminate the stuck VM");
});

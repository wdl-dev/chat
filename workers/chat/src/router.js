import {
  errMessage,
  httpError,
  jsonResponse,
  requireSecretEqual,
} from "./lib.js";

const DELEGATED_TEMPLATE = "wdl-chat-ns-pool";
// The wdl-chat-ns-pool template's server-side TTL.
const DELEGATED_TTL_MS = 6 * 60 * 60_000;
const NS_TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
// Each retry sleeps base..2*base; the whole ladder adds under ~1.6s to a start that would otherwise 503.
const DELEGATED_ISSUE_BACKOFF_MS = [80, 200, 500];
const DELEGATED_ISSUE_MAX_ATTEMPTS = DELEGATED_ISSUE_BACKOFF_MS.length + 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_JSON_BODY_BYTES = 256 * 1024; // bounds JSON body parse cost (>> the 50KB message cap)
const MAX_USER_MESSAGE_BYTES = 50_000;
const MAX_UPLOAD_BODY_BYTES = 16 * 1024 * 1024;

const SESSION_ROUTE = /^\/sessions\/([^/]+)(?:\/(messages|cancel|close|stream|approve-plan|export|upload))?$/;
const MAX_PLAN_NOTE_BYTES = 5000;
const PLAN_DECISIONS = new Set(["approve", "revise", "reject"]);
const ADMIN_SESSION_FORCE_CLOSE = /^\/admin\/sessions\/([^/]+)\/force-close$/;

function getDoStub(env, sessionId) {
  const id = env.CHAT_SESSION_DO.idFromName(sessionId);
  return env.CHAT_SESSION_DO.get(id);
}

async function mintDelegatedNsOnce(env, fetcher) {
  let res;
  try {
    res = await fetcher(`${env.ADMIN_URL}/auth/delegated-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": env.TOKEN_ISSUER_TOKEN },
      body: JSON.stringify({ template: DELEGATED_TEMPLATE }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, status: 0, reason: "unreachable", detail: errMessage(err) };
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok || typeof data?.token !== "string" || typeof data?.ns !== "string") {
    // `error` is the auth reason code; the rest of the body can carry a minted token, so never log it.
    return { ok: false, status: res.status, reason: typeof data?.error === "string" ? data.error : "" };
  }
  return { ok: true, ns: data.ns, nsToken: data.token, tokenId: data.tokenId };
}

async function mintDelegatedNs(env, fetcher) {
  if (!env.ADMIN_URL) throw httpError(503, "ADMIN_URL not configured");
  if (!env.TOKEN_ISSUER_TOKEN) throw httpError(503, "TOKEN_ISSUER_TOKEN not configured");
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    const out = await mintDelegatedNsOnce(env, fetcher);
    if (out.ok) {
      if (attempt > 1) {
        console.log(`delegated token issued after ${attempt} attempts in ${Date.now() - startedAt}ms`);
      }
      return { ns: out.ns, nsToken: out.nsToken, tokenId: out.tokenId };
    }
    // The issuer holds one lock per (issuer, template) and rejects rather than waits, so concurrent
    // "start session" requests all but one get 409 delegated_issue_busy — the only retriable code.
    // Minting has no idempotency key: a lost response may already have created a token this worker can
    // neither see nor revoke, so never retry a network throw. active_quota_exceeded is a real ceiling.
    const retriable = out.status === 409 && out.reason === "delegated_issue_busy";
    if (!retriable || attempt >= DELEGATED_ISSUE_MAX_ATTEMPTS) {
      const what = out.reason === "unreachable" ? `unreachable: ${out.detail}` : `${out.status} ${out.reason || "-"}`;
      console.warn(`delegated token issue failed (${what}) after ${attempt} attempts in ${Date.now() - startedAt}ms`);
      throw httpError(out.status === 409 ? 503 : 502, out.reason === "unreachable"
        ? "delegated token issue unreachable"
        : "delegated token issue failed");
    }
    const base = DELEGATED_ISSUE_BACKOFF_MS[attempt - 1];
    await sleep(base + Math.floor(Math.random() * base));
  }
}

async function lookupSessionIndex(env, sessionId) {
  const row = await env.CHAT_DB.prepare(
    `SELECT id, ns, status, created_at FROM sessions_index WHERE id = ?1`
  ).bind(sessionId).first();
  return row ?? null;
}

function sessionDeadline(idx) {
  const created = Number(idx?.created_at);
  return Number.isFinite(created) ? created + DELEGATED_TTL_MS - NS_TOKEN_EXPIRY_MARGIN_MS : null;
}

function sessionExpired(idx) {
  const deadline = sessionDeadline(idx);
  return deadline !== null && Date.now() >= deadline;
}

// Lazy termination: a stale session is torn down on next access, not by a background reaper.
async function expireSession(env, sessionId) {
  const stub = getDoStub(env, sessionId);
  try {
    await stub.expire();
  } catch (err) {
    // DO facets pinned to a pre-expire() worker version still have requestClose (same teardown, generic reason).
    try { await stub.requestClose(); }
    catch (err2) { console.warn(`expire teardown failed for ${sessionId}: ${errMessage(err)}; fallback: ${errMessage(err2)}`); }
  }
  await markSessionClosed(env, sessionId);
}

// The common gate: the session must exist and be active, or 404 (410 if it just expired). Returns the row.
async function requireActiveSession(env, sessionId) {
  const idx = await lookupSessionIndex(env, sessionId);
  if (!idx || idx.status !== "active") throw httpError(404, "session not active");
  if (sessionExpired(idx)) {
    await expireSession(env, sessionId);
    throw httpError(410, "session expired");
  }
  return idx;
}

async function markSessionClosed(env, sessionId) {
  await env.CHAT_DB.prepare(
    `UPDATE sessions_index SET status = 'closed', last_active_at = ?1 WHERE id = ?2`
  ).bind(Date.now(), sessionId).run();
}

function passcodeGate(env, body) {
  const presented = (body && typeof body.passcode === "string") ? body.passcode : "";
  requireSecretEqual(presented, env.DEMO_PASSCODE, "DEMO_PASSCODE", "passcode");
}

async function handleStartSession(env, body, fetcher) {
  passcodeGate(env, body);
  const lang = body?.lang === "zh" ? "zh" : "en";
  const { ns, nsToken, tokenId } = await mintDelegatedNs(env, fetcher);
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  await env.CHAT_DB.prepare(
    `INSERT INTO sessions_index (id, ns, ns_token_id, created_at, last_active_at, status)
     VALUES (?1, ?2, ?3, ?4, ?4, 'active')`
  ).bind(sessionId, ns, tokenId ?? null, now).run();
  const expiresAt = sessionDeadline({ created_at: now });
  try {
    await getDoStub(env, sessionId).init({ sessionId, ns, nsToken, expiresAt, lang });
  } catch (err) {
    await markSessionClosed(env, sessionId);
    console.warn(`session init failed: ${errMessage(err)}`);
    throw httpError(502, "session init failed");
  }
  return jsonResponse(200, { sessionId, ns, expiresAt });
}

async function handlePostMessage(env, sessionId, body) {
  if (typeof body?.content !== "string" || body.content.length === 0) {
    throw httpError(400, "content required");
  }
  const bytes = new TextEncoder().encode(body.content).byteLength;
  if (bytes > MAX_USER_MESSAGE_BYTES) {
    throw httpError(413, `content too large (${bytes} > ${MAX_USER_MESSAGE_BYTES} bytes)`);
  }
  await requireActiveSession(env, sessionId);
  const mode = body?.mode === "plan_confirmed" ? "plan_confirmed" : "free_form";
  const result = await getDoStub(env, sessionId).addUserMessage({ content: body.content, mode });
  return jsonResponse(202, result);
}

async function handleApprovePlan(env, sessionId, body) {
  const decision = body?.decision;
  if (!PLAN_DECISIONS.has(decision)) {
    throw httpError(400, `decision must be one of: ${[...PLAN_DECISIONS].join(", ")}`);
  }
  const runId = body?.runId;
  if (typeof runId !== "string" || !runId) throw httpError(400, "runId required");
  let note;
  if (decision === "revise") {
    note = typeof body?.note === "string" ? body.note : "";
    const bytes = new TextEncoder().encode(note).byteLength;
    if (bytes > MAX_PLAN_NOTE_BYTES) {
      throw httpError(413, `note too large (${bytes} > ${MAX_PLAN_NOTE_BYTES} bytes)`);
    }
  }
  await requireActiveSession(env, sessionId);

  // caller-supplied runId: verify it belongs to this session before forwarding.
  const belongs = await getDoStub(env, sessionId).runBelongsToSession(runId);
  if (!belongs?.exists) throw httpError(404, "run not found for session");

  // Use the server's known await attempt, not a client-echoed one, so the approval reaches the channel the run waits on.
  const instance = await env.CHAT_RUN.get(runId);
  await instance.sendEvent({ type: `plan_approval-${belongs.attempt}`, payload: { decision, note } });
  return jsonResponse(200, { ok: true });
}

async function handleCancel(env, sessionId) {
  await requireActiveSession(env, sessionId);
  const result = await getDoStub(env, sessionId).cancelLatestRun();
  return jsonResponse(200, result);
}

async function handleClose(env, sessionId) {
  const idx = await lookupSessionIndex(env, sessionId);
  if (!idx) throw httpError(404, "session not found");
  if (idx.status === "closed") return jsonResponse(200, { ok: true, alreadyClosed: true });

  const stub = getDoStub(env, sessionId);
  // requestClose also terminates the session's MicroVM.
  try { await stub.requestClose(); } catch {}

  await markSessionClosed(env, sessionId);
  return jsonResponse(200, { ok: true });
}

// GET /stream & /export forward to the DO; 404 on a closed session (no replay-by-id after close).
async function proxyGetToDo(req, env, sessionId, path) {
  const idx = await lookupSessionIndex(env, sessionId);
  if (!idx) throw httpError(404, "session not found");
  if (idx.status !== "active") throw httpError(404, "session closed");
  if (sessionExpired(idx)) {
    await expireSession(env, sessionId);
    throw httpError(404, "session closed");
  }
  return await getDoStub(env, sessionId).fetch(
    new Request(`https://do/${path}`, { method: "GET", headers: req.headers }),
  );
}

async function handleUpload(req, env, sessionId) {
  await requireActiveSession(env, sessionId);
  const len = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > MAX_UPLOAD_BODY_BYTES) {
    throw httpError(413, `upload too large (max ${MAX_UPLOAD_BODY_BYTES} bytes)`);
  }
  return await getDoStub(env, sessionId).fetch(new Request("https://do/upload", req));
}

function operatorGate(req, env) {
  const presented = req.headers.get("x-operator-token") ?? "";
  requireSecretEqual(presented, env.OPERATOR_TOKEN, "OPERATOR_TOKEN", "operator token");
}

async function handleAdminForceClose(req, env, sessionId) {
  operatorGate(req, env);
  const idx = await lookupSessionIndex(env, sessionId);
  if (!idx) throw httpError(404, "session not found");

  const stub = getDoStub(env, sessionId);
  try { await stub.cancelLatestRun(); } catch {}
  // requestClose also terminates the session's MicroVM.
  try { await stub.requestClose(); } catch {}
  await markSessionClosed(env, sessionId);
  return jsonResponse(200, { ok: true, sessionId });
}

async function readJsonBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const len = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > MAX_JSON_BODY_BYTES) {
    throw httpError(413, `request body too large (max ${MAX_JSON_BODY_BYTES} bytes)`);
  }
  const reader = req.body?.getReader?.();
  if (!reader) return {};
  const dec = new TextDecoder();
  let text = "", total = 0;
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); }
    catch { return {}; }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw httpError(413, `request body too large (max ${MAX_JSON_BODY_BYTES} bytes)`);
    }
    text += dec.decode(chunk.value, { stream: true });
  }
  text += dec.decode();
  if (text.length === 0) return {};
  try { return JSON.parse(text); }
  catch { throw httpError(400, "invalid JSON body"); }
}

export async function handleRequest(req, env, fetcher = fetch) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  try {
    if (req.method === "POST" && pathname === "/portal/start") {
      return await handleStartSession(env, await readJsonBody(req), fetcher);
    }

    const sessionMatch = pathname.match(SESSION_ROUTE);
    if (sessionMatch) {
      const [, sessionId, sub] = sessionMatch;
      if (req.method === "POST" && sub === "messages") {
        return await handlePostMessage(env, sessionId, await readJsonBody(req));
      }
      if (req.method === "POST" && sub === "cancel") {
        return await handleCancel(env, sessionId);
      }
      if (req.method === "POST" && sub === "close") {
        return await handleClose(env, sessionId);
      }
      if (req.method === "GET" && sub === "stream") {
        return await proxyGetToDo(req, env, sessionId, "stream");
      }
      if (req.method === "POST" && sub === "approve-plan") {
        return await handleApprovePlan(env, sessionId, await readJsonBody(req));
      }
      if (req.method === "GET" && sub === "export") {
        return await proxyGetToDo(req, env, sessionId, "export");
      }
      if (req.method === "POST" && sub === "upload") {
        return await handleUpload(req, env, sessionId);
      }
    }

    const adminClose = pathname.match(ADMIN_SESSION_FORCE_CLOSE);
    if (req.method === "POST" && adminClose) {
      return await handleAdminForceClose(req, env, adminClose[1]);
    }

    return jsonResponse(404, { error: "not found" });
  } catch (err) {
    const status = err?.status ?? 500;
    return jsonResponse(status, { error: err?.clientMessage ?? "internal error" });
  }
}

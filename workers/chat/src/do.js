import { DurableObject } from "cloudflare:workers";
import { bytesToBase64, capText, errMessage, extractText, httpError, jsonResponse, newRunId, parseJson, safeUploadName, sseEvent, toolResultBlock, uniqueUploadName } from "./lib.js";
import { callLlmMessages, resolveLlmConfig } from "./llm.js";
import { hasAnswerContent, isUserTextTurn, replayLlmTurnOutcome, replayPlanOutcome, toolBatchAlreadyRan, windowLlmMessages } from "./messages.js";
import { decideStartRun, isTerminalRunStatus } from "./runstate.js";
import { dispatchTool, uploadAsset } from "./tools.js";
import { TOOL_DEFINITIONS, promptPack, isInternalMarker } from "./agent-prompt.js";

const SSE_ENCODER = new TextEncoder();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS session_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    seq        INTEGER PRIMARY KEY,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    run_id           TEXT PRIMARY KEY,
    status           TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    cancel_reason    TEXT,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER,
    error            TEXT,
    stop_reason      TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS steps (
    run_id     TEXT NOT NULL,
    step_no    INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    input      TEXT,
    output     TEXT,
    status     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    PRIMARY KEY (run_id, step_no)
  )`,
  `CREATE INDEX IF NOT EXISTS runs_status ON runs(status, started_at)`,
];

const HISTORY_REPLAY_LIMIT = 50;

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "tail_logs", "web_search", "web_fetch"]);
// Tools that never touch the MicroVM — a batch of only these must not boot (or wait on) one.
const SANDBOXLESS_TOOLS = new Set(["web_search", "web_fetch"]);
// Safe to re-run on a redispatch: read-only tools + write_file (idempotent — same path+content).
// Everything else (run_command / deploy_test / call_preview) can have non-idempotent side effects.
const REPLAY_SAFE_TOOLS = new Set([...READ_ONLY_TOOLS, "write_file"]);

const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 15 * 1024 * 1024;
const MAX_ASSETS_INDEX = 50;
const MAX_TOOL_USES_PER_TURN = 16;
const EXPORT_FETCH_TIMEOUT_MS = 120_000; // DO→agent /export budget (agent tar has its own wall-clock)
const PERSIST_STEP_FIELD_CAP = 128 * 1024;

// Truncate the large run_command fields before persisting a step's output, so repeated big-output
// commands can't grow the DO SQLite unbounded. toolResultBlock still caps the model-facing copy.
function capStepOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  let capped = output;
  for (const k of ["stdout", "stderr"]) {
    const v = output[k];
    if (typeof v === "string" && v.length > PERSIST_STEP_FIELD_CAP) {
      capped = { ...capped, [k]: capText(v, PERSIST_STEP_FIELD_CAP), [`${k}Truncated`]: true };
    }
  }
  return capped;
}

// The captured group comes from a JSON string literal that may still be mid-escape.
function unescapeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

// Cap the tool_use blocks in an assistant turn so a runaway turn can't require an unbounded batch of
// tool_results anywhere downstream (dispatch, supersede synth, redispatch). Non-tool_use blocks kept.
function capToolUses(content) {
  if (!Array.isArray(content)) return content;
  let seen = 0;
  return content.filter(b => b?.type !== "tool_use" || ++seen <= MAX_TOOL_USES_PER_TURN);
}

// Strict equality, so a step journaled before batchSeq existed matches nothing and its tool re-runs —
// the safe direction, and only reachable for a run in flight when its facet picked up this version.
function sameBatch(stepInput, batchSeq) {
  return stepInput?.batchSeq === batchSeq;
}

function firstRow(cursor) {
  for (const row of cursor) return row;
  return null;
}

export class ChatSessionDO extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.subscribers = new Set();
    this.abortControllers = new Map(); // runId -> Set<AbortController>
    this._toolBatchInFlight = new Map();
    this._llmTurnInFlight = new Map();
    this._planLlmInFlight = new Map();
    this._markerInFlight = new Map();
    this._ensureInFlight = new Map();
    state.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA) this.sql.exec(stmt);
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // reason ∈ {"user_stop","user_close","user_supersede","llm_timeout","expired"}
  _cancelRun(runId, reason) {
    this.sql.exec(
      "UPDATE runs SET cancel_requested = 1, cancel_reason = ? WHERE run_id = ?",
      reason, runId,
    );
    const set = this.abortControllers.get(runId);
    if (set) {
      for (const ac of set) {
        try { ac.abort(reason); } catch { /* already aborted */ }
      }
    }
  }

  _registerAbort(runId, ac) {
    let set = this.abortControllers.get(runId);
    if (!set) { set = new Set(); this.abortControllers.set(runId, set); }
    set.add(ac);
  }

  _releaseAbort(runId, ac) {
    const set = this.abortControllers.get(runId);
    if (!set) return;
    set.delete(ac);
    if (set.size === 0) this.abortControllers.delete(runId);
  }

  _readCancelReason(runId) {
    const row = firstRow(this.sql.exec(
      "SELECT cancel_reason FROM runs WHERE run_id = ?", runId,
    ));
    return row?.cancel_reason ?? null;
  }

  _latestActiveRunId() {
    const row = firstRow(this.sql.exec(
      "SELECT run_id FROM runs WHERE status IN ('pending', 'running') ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ));
    return row?.run_id ?? null;
  }

  async init({ sessionId, ns, nsToken, expiresAt, lang }) {
    if (typeof sessionId !== "string" || !sessionId) throw httpError(400, "sessionId required");
    if (typeof ns !== "string" || !ns) throw httpError(400, "ns required");
    if (typeof nsToken !== "string" || !nsToken) throw httpError(400, "nsToken required");
    this._writeMeta("sessionId", sessionId);
    this._writeMeta("ns", ns);
    this._writeMeta("nsToken", nsToken);
    if (Number.isFinite(expiresAt)) this._writeMeta("expiresAt", String(expiresAt));
    this._writeMeta("lang", lang === "zh" ? "zh" : "en");
    return { ok: true };
  }

  async addUserMessage({ content, mode }) {
    if (this._readMeta("closed")) throw httpError(409, "session closed");
    if (typeof content !== "string" || !content) throw httpError(400, "content required");
    const now = Date.now();

    // Every tool_use needs a matching tool_result in the next user turn (API 400s otherwise).
    this._finalizePendingToolUses(now);

    const activeRunId = this._latestActiveRunId();
    if (activeRunId) {
      this._cancelRun(activeRunId, "user_supersede");
      await this._wakePlanWait(activeRunId);
    }

    const seq = this._insertMessage("user", [{ type: "text", text: content }], now);
    const runId = newRunId();
    const runMode = mode === "plan_confirmed" ? "plan_confirmed" : "free_form";
    this.sql.exec(
      "INSERT INTO runs (run_id, status, cancel_requested, started_at) VALUES (?, 'pending', 0, ?)",
      runId, now,
    );
    this._broadcast("message.user", { seq, content, createdAt: now });
    this._broadcast("run.scheduled", { runId, mode: runMode });
    try {
      await this._launchWorkflow(runId, runMode);
    } catch (err) {
      console.warn(`workflow launch failed: ${errMessage(err)}`);
      this._endRun(runId, "failed", "workflow launch failed");
      this._broadcast("run.failed", { runId, error: "workflow launch failed" });
      throw err;
    }
    return { runId, seq, mode: runMode };
  }

  async _launchWorkflow(runId, mode) {
    const sessionId = this._readMeta("sessionId");
    if (!sessionId) throw httpError(500, "session not initialized");
    await this.env.CHAT_RUN.create({
      id: runId,
      params: { sessionId, runId, mode },
      // Short retention so completed instances don't pin chat-worker versions in DB 2.
      retention: { successRetention: "1h", errorRetention: "24h" },
    });
  }

  async _terminateWorkflow(runId) {
    try {
      const instance = await this.env.CHAT_RUN.get(runId);
      await instance.terminate();
    } catch { /* workflow may already be terminal or missing */ }
  }

  // Wake a plan_approval wait so cancel/supersede takes effect now, not after the 5-min timeout.
  async _wakePlanWait(runId) {
    try {
      const attempt = this._readMeta("planAwaitAttempt:" + runId) || "0";
      const instance = await this.env.CHAT_RUN.get(runId);
      await instance.sendEvent({ type: `plan_approval-${attempt}`, payload: { decision: "__canceled__" } });
    } catch (err) {
      // benign when not in plan mode / already terminal; log so a real sendEvent failure isn't hidden.
      console.warn(`_wakePlanWait(${runId}): ${errMessage(err)}`);
    }
  }

  _finalizePendingToolUses(now) {
    const last = firstRow(this.sql.exec(
      "SELECT seq, role, content FROM messages ORDER BY seq DESC LIMIT 1",
    ));
    if (!last || last.role !== "assistant") return;
    const blocks = parseJson(last.content);
    if (!Array.isArray(blocks)) return;
    const toolUses = blocks.filter(b => b?.type === "tool_use");
    if (toolUses.length === 0) return;
    const synth = toolUses.map(tu =>
      toolResultBlock(tu.id, { aborted: true, reason: "superseded by new user turn" }, true));
    const seq = this._insertMessage("user", synth, now);
    this._broadcast("message.tool_results", { seq, count: synth.length, synthesized: true });
  }

  async cancelLatestRun() {
    const runId = this._latestActiveRunId();
    if (!runId) return { ok: false, reason: "no active run" };
    this._cancelRun(runId, "user_stop");
    await this._wakePlanWait(runId);
    this._broadcast("run.cancelRequested", { runId });
    return { ok: true, runId };
  }

  // Per-session DO: runId existence proves it belongs to this session.
  async runBelongsToSession(runId) {
    const row = firstRow(this.sql.exec("SELECT 1 AS ok FROM runs WHERE run_id = ? LIMIT 1", runId));
    return { exists: !!row, attempt: this._readMeta("planAwaitAttempt:" + runId) || "0" };
  }

  async requestClose() {
    return this._closeSession("user_close");
  }

  async expire() {
    return this._closeSession("expired");
  }

  async _closeSession(reason) {
    this._writeMeta("closed", "1");
    const activeRunId = this._latestActiveRunId();
    if (activeRunId) {
      this._cancelRun(activeRunId, reason);
      await this._terminateWorkflow(activeRunId);
      // terminate() skips _endRun, so settle here or the row stays pending forever.
      this._endRun(activeRunId, "aborted");
    }
    const microvmId = this._readMeta("microvmId");
    if (microvmId) {
      let vmClosed = true;
      try { await this.env.BROKER.closeSession({ microvmId }); }
      catch (err) { vmClosed = false; console.warn(`closeSession failed for ${microvmId}: ${errMessage(err)}`); }
      // keep the handle on close failure so a re-close can retry (broker idle policy is the backstop).
      if (vmClosed) {
        this._writeMeta("microvmId", "");
        this._writeMeta("microvmEndpoint", "");
        this._writeMeta("microvmAuthToken", "");
      }
    }
    this._broadcast("session.closed", { reason });
    for (const ctl of this.subscribers) {
      try { ctl.close(); } catch { /* peer gone */ }
    }
    this.subscribers.clear();
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, "session closed"); } catch { /* peer gone */ }
    }
    return { ok: true };
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/export") return this._handleExport();
    if (req.method === "POST" && url.pathname === "/upload") return this._handleUpload(req);
    if (req.method !== "GET" || url.pathname !== "/stream") {
      return new Response("ChatSessionDO is RPC-only except for GET /stream, /export, POST /upload", { status: 405 });
    }
    if ((req.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      return this._handleWebSocketUpgrade();
    }
    return this._handleStream();
  }

  // Hibernatable-WS handlers the runtime requires; we push via _broadcast, so these are no-ops.
  webSocketMessage(_ws, _message) {}
  webSocketClose(_ws, _code, _reason, _wasClean) {}
  webSocketError(_ws, _err) {}

  async workflowStartRun({ runId }) {
    const row = firstRow(this.sql.exec(
      "SELECT status, cancel_requested FROM runs WHERE run_id = ?", runId,
    ));
    const decision = decideStartRun(row);
    if (decision.settleCancelled) {
      // Settle now or the run stays 'pending' and replay treats it active forever.
      const reason = this._readCancelReason(runId) ?? "cancelled";
      this._endRun(runId, "aborted");
      this._broadcast("run.aborted", { runId, reason });
      return { skip: true, reason };
    }
    if (decision.skip) return { skip: true, reason: decision.reason };
    if (decision.markRunning) this.sql.exec("UPDATE runs SET status = 'running' WHERE run_id = ?", runId);
    return { ok: true };
  }

  async workflowIsCancelled({ runId }) {
    return this._isCancelled(runId);
  }

  async workflowEndRun({ runId, status, error = null, stopReason = null }) {
    // Terminal-idempotent: don't re-broadcast if the run already settled.
    if (!this._endRun(runId, status, error, stopReason)) return { ok: true, skipped: true };
    const payload = { runId };
    if (error != null) payload.error = error;
    if (status === "aborted") {
      const reason = this._readCancelReason(runId);
      if (reason != null) payload.reason = reason;
    }
    if (stopReason != null) payload.stop_reason = stopReason;
    this._broadcast(`run.${status}`, payload);
    return { ok: true };
  }

  // Single-flight: coalesce concurrent re-dispatch onto one execution; each caller owns its own map+key.
  _coalesce(map, key, fn) {
    const inflight = map.get(key);
    if (inflight) return inflight;
    const run = fn().finally(() => {
      if (map.get(key) === run) map.delete(key);
    });
    map.set(key, run);
    return run;
  }

  _lastSeq(role = null) {
    const row = role
      ? firstRow(this.sql.exec("SELECT seq FROM messages WHERE role = ? ORDER BY seq DESC LIMIT 1", role))
      : firstRow(this.sql.exec("SELECT seq FROM messages ORDER BY seq DESC LIMIT 1"));
    return row?.seq ?? null;
  }

  _lastMessage() {
    return firstRow(this.sql.exec("SELECT role, content FROM messages ORDER BY seq DESC LIMIT 1"));
  }

  // Key changes when a new message lands, so a retried dispatch doesn't join a stale in-flight run.
  _coalesceKey(runId, { role = null, prefix = "" } = {}) {
    return `${prefix}${runId}:${this._lastSeq(role) ?? "none"}`;
  }

  _insertMessage(role, blocks, now) {
    const seq = this._nextSeq();
    this.sql.exec(
      "INSERT INTO messages (seq, role, content, created_at) VALUES (?, ?, ?, ?)",
      seq, role, JSON.stringify(blocks), now,
    );
    return seq;
  }

  // Turns stream deltas into UI broadcasts; the closure's maps carry the per-turn throttle state.
  _progressBroadcaster(runId) {
    const toolBytes = new Map();
    const toolPaths = new Map();
    const thinkingStartAt = new Map();
    const thinkingLastAt = new Map();
    return (event) => {
      if (event.type === "text_delta") {
        this._broadcast("message.assistant_streaming", { runId, blockIndex: event.index, delta: event.text });
      } else if (event.type === "thinking_delta") {
        // Reasoning can run for most of a turn with nothing else on screen. Announce it and let
        // the client count the seconds; the text itself still renders collapsed at commit.
        // Rebroadcast every few seconds rather than once: a reattach replays run.scheduled,
        // which clears the client's row, and an interleaved thinking block after text must
        // re-arm it — the client ignores repeats while its indicator is live.
        const last = thinkingLastAt.get(event.index);
        if (last !== undefined && Date.now() - last < 5000) return;
        thinkingLastAt.set(event.index, Date.now());
        // startedAt rides along so a reattached client shows the true elapsed, not a reset counter.
        const startedAt = thinkingStartAt.get(event.index) ?? Date.now();
        thinkingStartAt.set(event.index, startedAt);
        this._broadcast("message.thinking", { runId, blockIndex: event.index, startedAt });
      } else if (event.type === "tool_use_partial") {
        toolBytes.set(event.index, 0);
        this._broadcast("message.tool_pending", { runId, blockIndex: event.index, name: event.name, bytes: 0 });
      } else if (event.type === "tool_use_progress") {
        // `path` is the first property the file tools declare, so it lands in the opening bytes —
        // surface it while the content is still streaming rather than only at commit.
        let foundPath = false;
        if (!toolPaths.has(event.index)) {
          const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(event.head ?? "");
          if (m) { toolPaths.set(event.index, unescapeJsonString(m[1])); foundPath = true; }
        }
        // Otherwise one broadcast per 2 KB — the point is visible movement, not byte accuracy.
        if (!foundPath && event.bytes - (toolBytes.get(event.index) ?? 0) < 2048) return;
        toolBytes.set(event.index, event.bytes);
        this._broadcast("message.tool_pending", {
          runId, blockIndex: event.index, name: event.name, path: toolPaths.get(event.index), bytes: event.bytes,
        });
      }
    };
  }

  // Budget the LLM await (cfg.budgetMs) so the step can't outlive the dispatch; returns the response or an {outcome}.
  async _runLlmStep({ runId, stepNo, cfg, system, messages, tools, maxTokens, silent = false, reasoning = false }) {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      this.sql.exec(
        "UPDATE runs SET cancel_requested = 1, cancel_reason = COALESCE(cancel_reason, ?) WHERE run_id = ?",
        "llm_timeout", runId,
      );
      try { ac.abort("llm_timeout"); } catch { /* already aborted */ }
    }, cfg.budgetMs);
    this._registerAbort(runId, ac);

    let resp;
    try {
      resp = await callLlmMessages({
        env: this.env,
        system,
        messages,
        tools,
        maxTokens,
        // reasoning: force the full model (don't let pickModel silently downgrade the plan).
        model: reasoning ? cfg.model : undefined,
        signal: ac.signal,
        // The budget is our own deadline: keep whatever the turn already produced instead of
        // throwing away work the user watched stream in. A user Stop/Close carries a different
        // reason and still discards, which is what they asked for.
        salvageOnAbort: (reason) => reason === "llm_timeout",
        onDelta: silent ? undefined : this._progressBroadcaster(runId),
      });
    } catch (err) {
      this._releaseAbort(runId, ac);
      clearTimeout(timer);
      const aborted = ac.signal.aborted;
      const status = aborted ? "aborted" : "failed";
      const reason = this._abortReason(ac.signal, runId);
      const errStr = errMessage(err);
      this._completeStep(runId, stepNo, { error: errStr, reason }, status);
      return aborted ? { outcome: "aborted", reason } : { outcome: "failed", error: errStr };
    }
    this._releaseAbort(runId, ac);
    clearTimeout(timer);
    if (resp?.salvaged) {
      // Undo the deadline's own cancel so the loop continues with the partial turn. Scoped to
      // 'llm_timeout': a user Stop writes its own reason (_cancelRun overwrites, only the timer
      // COALESCEs), so whichever side of the deadline it lands on it doesn't match here, the cancel
      // survives, and the check below discards the salvage — Stop always wins.
      this.sql.exec(
        "UPDATE runs SET cancel_requested = 0, cancel_reason = NULL WHERE run_id = ? AND cancel_reason = 'llm_timeout'",
        runId,
      );
    }
    // Landing race: a supersede/cancel can arrive while the LLM await is in flight (or as it resolves).
    // Don't record a stale reply — it could sort after the new user turn and poison the next context.
    if ((ac.signal.aborted && !resp?.salvaged) || this._isCancelled(runId)) {
      const reason = this._abortReason(ac.signal, runId) ?? this._readCancelReason(runId);
      this._completeStep(runId, stepNo, { aborted: true, reason }, "aborted");
      return { outcome: "aborted", reason };
    }
    this._completeStep(runId, stepNo, this._sanitizeLlmResponse(resp), "done");
    return resp;
  }

  async workflowExecuteLlmTurn({ runId, planContext = null }) {
    if (this._isCancelled(runId)) return { outcome: "aborted" };
    // At-least-once: replay the recorded reply instead of re-calling the LLM.
    const replay = replayLlmTurnOutcome(this._lastMessage(), this._readMeta("lastAssistantStop"));
    if (replay) return replay;
    const key = this._coalesceKey(runId);
    return this._coalesce(this._llmTurnInFlight, key, () => this._executeLlmTurn(runId, planContext));
  }

  async _executeLlmTurn(runId, planContext) {
    const messages = this._buildLlmMessages({ maxMessages: 60 });
    // Before journaling the step, so a bad LLM_* value fails the run without leaving one behind.
    const cfg = resolveLlmConfig(this.env);
    const stepNo = this._startLlmStep(runId, "llm_call", messages.length);

    const P = promptPack(this._lang());
    const planSuffix = (typeof planContext === "string" && planContext.length > 0)
      ? P.planSuffix(planContext)
      : "";
    const anchor = this._getAnchorUserText();
    const anchorSuffix = anchor ? P.anchorSuffix(anchor) : "";
    const assets = this._readAssets();
    const assetsSuffix = assets.length ? P.assetsSuffix(assets) : "";
    const system = P.system + planSuffix + anchorSuffix + assetsSuffix;

    const result = await this._runLlmStep({
      runId, stepNo, cfg, system, messages,
      tools: TOOL_DEFINITIONS, maxTokens: cfg.maxTokens,
    });
    if (result?.outcome) return result;
    const resp = result;

    if (this._isCancelled(runId)) return { outcome: "aborted" };
    const content = resp?.content ?? [];
    if (!hasAnswerContent(content)) {
      // Not recorded: replayed forever, a text-less tool-less assistant turn can 400 strict
      // providers for the rest of the session, and the retry is cleaner without it.
      return { outcome: "done", stopReason: resp?.stop_reason ?? null, hasToolUses: false, hasOutput: false };
    }
    this._recordAssistant(resp);

    const hasToolUses = content.some(b => b?.type === "tool_use");
    return { outcome: "done", stopReason: resp?.stop_reason ?? null, hasToolUses, hasOutput: true };
  }

  async workflowRunToolBatch({ runId }) {
    if (this._isCancelled(runId)) return { outcome: "aborted" };
    // At-least-once: if the tool_results turn exists, the batch ran — don't re-execute.
    if (toolBatchAlreadyRan(this._lastMessage())) return { outcome: "done" };
    const key = this._coalesceKey(runId, { role: "assistant" });
    return this._coalesce(this._toolBatchInFlight, key, () => this._runToolBatch(runId));
  }

  async _runToolBatch(runId) {
    const lastAsst = firstRow(this.sql.exec(
      "SELECT seq, content FROM messages WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1",
    ));
    // The assistant turn's seq scopes replay: providers reuse ids like `call_0` across turns, so a
    // later batch must not inherit an earlier batch's result for the same id.
    const batchSeq = lastAsst?.seq ?? null;
    let toolUses = [];
    try {
      const blocks = JSON.parse(lastAsst?.content ?? "[]");
      if (Array.isArray(blocks)) toolUses = blocks.filter(b => b?.type === "tool_use");
    } catch { toolUses = []; }
    if (toolUses.length === 0) return { outcome: "done" };
    if (this._isCancelled(runId)) return { outcome: "aborted" };

    // On failure synthesize an error tool_result per tool_use so the API contract holds.
    try {
      if (toolUses.some(tu => !SANDBOXLESS_TOOLS.has(tu.name))) await this._ensureSandbox();
    } catch (err) {
      console.warn(`sandbox open failed: ${errMessage(err)}`);
      const results = toolUses.map(tu => toolResultBlock(tu.id, { error: "sandbox unavailable" }, true));
      const seq = this._insertMessage("user", results, Date.now());
      this._broadcast("message.tool_results", { seq, count: results.length });
      return { outcome: "done" };
    }

    const ctx = this._buildToolCtx();
    const toolResults = [];
    let abortedMidway = false;
    const completedTools = this._completedToolResults(runId, batchSeq);
    const priorRunning = this._priorRunningTools(runId, batchSeq);
    let i = 0;
    while (i < toolUses.length) {
      if (this._isCancelled(runId)) { abortedMidway = true; break; }

      // Resume: a tool completed on a prior dispatch keeps its result (no re-run of side effects).
      const cached = completedTools.get(toolUses[i].id);
      if (cached) { toolResults.push(cached); i++; continue; }

      let j = i;
      while (j < toolUses.length && READ_ONLY_TOOLS.has(toolUses[j].name)) j++;

      if (j > i + 1) {
        const batch = toolUses.slice(i, j);
        const result = await this._dispatchToolBatchParallel(runId, ctx, batch, batchSeq);
        toolResults.push(...result.toolResults);
        if (result.abortedMidway) { abortedMidway = true; break; }
        i = j;
        continue;
      }

      const tu = toolUses[i];
      const prior = priorRunning.get(tu.id);
      if (prior && !REPLAY_SAFE_TOOLS.has(tu.name)) {
        // A prior dispatch started this side-effecting tool but never recorded a terminal result — its
        // side effect may already have run. Fail closed (mark the stale step failed) instead of risking a
        // duplicate run_command / deploy / preview on redispatch.
        const out = { error: "a previous attempt of this tool may have already run; not re-running to avoid a duplicate side effect — re-check state before retrying" };
        this._completeStep(runId, prior.stepNo, out, "failed");
        toolResults.push(toolResultBlock(tu.id, out, true));
        i++;
        continue;
      }
      const result = await this._dispatchOneTool(runId, ctx, tu, batchSeq);
      toolResults.push(result.toolResult);
      if (result.status === "done" && tu.name === "deploy_test" && result.output?.versionId && result.output.previewUrl) {
        this._broadcast("preview.ready", {
          versionId: result.output.versionId,
          previewUrl: result.output.previewUrl,
          artifactMeta: result.output.artifactMeta ?? null,
        });
      }
      if (result.status === "aborted") { abortedMidway = true; break; }
      i++;
    }

    // On abort, leave tool_results unwritten — supersede already wrote synth'd results.
    if (abortedMidway || this._isCancelled(runId)) {
      return { outcome: "aborted" };
    }

    const userSeq = this._insertMessage("user", toolResults, Date.now());
    this._broadcast("message.tool_results", { seq: userSeq, count: toolResults.length });
    return { outcome: "done" };
  }

  async workflowDraftPlan({ runId, attempt = 0 }) {
    if (this._isCancelled(runId)) return { outcome: "aborted" };
    this._writeMeta("planAwaitAttempt:" + runId, String(attempt));
    const replay = replayPlanOutcome(this._lastMessage());
    if (replay) return replay;
    return this._coalescePlan(runId, () => this._runPlanLlm(runId, "plan_draft", attempt));
  }

  async workflowRevisePlan({ runId, note, attempt = 0 }) {
    if (this._isCancelled(runId)) return { outcome: "aborted" };
    // Idempotency scoped to this revise attempt (step revise_plan-N), not the note text: a new attempt runs even if the note repeats.
    const doneKey = `reviseAttemptDone:${runId}`;
    const done = Number(this._readMeta(doneKey) || "-1");
    if (attempt <= done) {
      // This attempt already recorded its plan — terminal, never re-run or re-append.
      return replayPlanOutcome(this._lastMessage()) ?? { outcome: "done", plan: "" };
    }
    const noteText = (typeof note === "string" && note.trim().length > 0)
      ? note
      : promptPack(this._lang()).planReviseFallback;
    // Append the note once — skip if this attempt already left it as the last message.
    if (!this._lastUserTextEquals(noteText)) this._appendUserMessage(noteText);
    this._writeMeta("planAwaitAttempt:" + runId, String(attempt));
    const key = this._coalesceKey(runId, { role: "assistant" });
    return this._coalescePlan(runId, async () => {
      const r = await this._runPlanLlm(runId, "plan_revise", attempt);
      if (r?.outcome === "done") this._writeMeta(doneKey, String(attempt));
      return r;
    }, key);
  }

  _coalescePlan(runId, fn, precomputedKey = null) {
    const key = precomputedKey ?? this._coalesceKey(runId);
    return this._coalesce(this._planLlmInFlight, key, fn);
  }

  // API rejects messages ending on assistant; inject a synth user turn before execute.
  async workflowAfterPlanApprove({ runId }) {
    if (this._isCancelled(runId)) return { outcome: "aborted" };
    const marker = promptPack(this._lang()).planConfirmMarker;
    if (this._lastUserTextEquals(marker)) return { outcome: "done" };
    return this._coalesceMarker(runId, "approve", () => this._appendUserMessage(marker));
  }

  _coalesceMarker(runId, kind, insert) {
    const key = this._coalesceKey(runId, { prefix: `${kind}:` });
    return this._coalesce(this._markerInFlight, key, async () => { insert(); return { outcome: "done" }; });
  }

  _appendUserMessage(content) {
    const seq = this._insertMessage("user", [{ type: "text", text: content }], Date.now());
    // Plan-confirm marker is internal orchestration: persist for the LLM window, don't show as a bubble.
    if (isInternalMarker(content)) return seq;
    this._broadcast("message.user", { seq, content, createdAt: Date.now() });
    return seq;
  }

  async _runPlanLlm(runId, kind, attempt = 0) {
    const messages = this._buildLlmMessages({ stripTools: true, maxMessages: 20 });
    // Before journaling the step, so a bad LLM_* value fails the run without leaving one behind.
    const cfg = resolveLlmConfig(this.env);
    const stepNo = this._startLlmStep(runId, kind, messages.length);

    const P = promptPack(this._lang());
    const assets = this._readAssets();
    const planSystem = P.planSystem + (assets.length ? P.assetsSuffix(assets) : "");
    const result = await this._runLlmStep({
      runId, stepNo, cfg, system: planSystem, messages,
      // Reasoning model, silent: room for chain-of-thought; plan renders as a card, not a bubble.
      tools: [], maxTokens: 8192, silent: true, reasoning: true,
    });
    if (result?.outcome) return result;
    const resp = result;

    const planText = extractText(resp?.content);
    if (!planText.trim()) {
      // Empty plan (budget spent on thinking): fail fast instead of parking on plan_approval.
      return { outcome: "failed", error: "plan generation produced no text — please try again" };
    }
    if (this._isCancelled(runId)) return { outcome: "aborted" };
    this._addPlanDraftSeq(this._recordAssistant(resp, { broadcast: false }));

    this._broadcast("plan.draft", { runId, kind, plan: planText, attempt });
    return { outcome: "done", plan: planText };
  }

  // signal.reason (string) wins, else persisted cancel_reason; null if not aborted.
  _abortReason(signal, runId) {
    if (!signal?.aborted) return null;
    return (typeof signal.reason === "string" ? signal.reason : null) ?? this._readCancelReason(runId);
  }

  // A tool_use with a terminal result on a prior dispatch of THIS batch — lets a re-dispatch reuse it.
  _completedToolResults(runId, batchSeq) {
    const out = new Map();
    for (const row of this.sql.exec(
      "SELECT input, output, status FROM steps WHERE run_id = ? AND kind = 'tool_call' AND status IN ('done', 'failed')",
      runId,
    )) {
      const input = parseJson(row.input);
      if (!input || !sameBatch(input, batchSeq)) continue;
      const id = input?.toolUseId;
      if (!id || out.has(id)) continue;
      const output = parseJson(row.output);
      out.set(id, toolResultBlock(id, output, row.status !== "done"));
    }
    return out;
  }

  // Non-terminal ('running') tool_call steps left by a prior dispatch — keyed by toolUseId so a
  // redispatch can fail closed on a side-effecting tool whose completion was never recorded.
  _priorRunningTools(runId, batchSeq) {
    const out = new Map();
    for (const row of this.sql.exec(
      "SELECT step_no, input FROM steps WHERE run_id = ? AND kind = 'tool_call' AND status = 'running'",
      runId,
    )) {
      const input = parseJson(row.input);
      if (!input || !sameBatch(input, batchSeq)) continue;
      const id = input?.toolUseId;
      if (!id || out.has(id)) continue;
      out.set(id, { name: input?.name, stepNo: row.step_no });
    }
    return out;
  }

  _startToolStep(runId, tu, batchSeq) {
    const stepNo = this._nextStepNo(runId);
    this._insertStep(runId, stepNo, "tool_call", { name: tu.name, input: tu.input, toolUseId: tu.id, batchSeq });
    return stepNo;
  }

  _startLlmStep(runId, kind, messageCount) {
    const stepNo = this._nextStepNo(runId);
    this._insertStep(runId, stepNo, kind, { messageCount });
    return stepNo;
  }

  _recordAssistant(resp, { broadcast = true } = {}) {
    const content = capToolUses(resp?.content ?? []);
    const seq = this._insertMessage("assistant", content, Date.now());
    // Persist the real stop_reason so a re-dispatch replay is faithful (see replayLlmTurnOutcome).
    this._writeMeta("lastAssistantStop", typeof resp?.stop_reason === "string" ? resp.stop_reason : "");
    if (broadcast) this._broadcast("message.assistant", { seq, content, stop_reason: resp?.stop_reason });
    return seq;
  }

  // Plan-draft messages render as a card, not a bubble; track their seqs to skip on replay.
  _addPlanDraftSeq(seq) {
    let arr = parseJson(this._readMeta("planDraftSeqs"));
    if (!Array.isArray(arr)) arr = [];
    arr.push(seq);
    this._writeMeta("planDraftSeqs", JSON.stringify(arr));
  }
  _isPlanDraftSeq(seq) {
    const arr = parseJson(this._readMeta("planDraftSeqs"));
    return Array.isArray(arr) && arr.includes(seq);
  }

  _lastUserTextEquals(text) {
    return isUserTextTurn(this._lastMessage(), text);
  }

  async _attemptTool(ctx, tu, signal) {
    try {
      return { ok: true, output: await dispatchTool({ name: tu.name, input: tu.input, ctx, signal }) };
    } catch (err) {
      return { ok: false, output: { error: errMessage(err) } };
    }
  }

  _finishToolStep(runId, stepNo, tu, settled, signal) {
    const status = settled.ok ? "done" : (signal.aborted ? "aborted" : "failed");
    const output = capStepOutput(settled.output);
    this._completeStep(runId, stepNo, output, status);
    return { status, output, toolResult: toolResultBlock(tu.id, output, status !== "done") };
  }

  async _dispatchOneTool(runId, ctx, tu, batchSeq) {
    const stepNo = this._startToolStep(runId, tu, batchSeq);
    const tac = new AbortController();
    this._registerAbort(runId, tac);
    let settled;
    try {
      settled = await this._attemptTool(ctx, tu, tac.signal);
    } finally {
      this._releaseAbort(runId, tac);
    }
    const { status, output, toolResult } = this._finishToolStep(runId, stepNo, tu, settled, tac.signal);
    return { stepNo, status, output, toolResult };
  }

  // Shared AbortController so a cancel cascades to every child fetch.
  async _dispatchToolBatchParallel(runId, ctx, batch, batchSeq) {
    const stepNos = batch.map(tu => this._startToolStep(runId, tu, batchSeq));
    const tac = new AbortController();
    this._registerAbort(runId, tac);
    let abortedMidway = false;
    try {
      const settled = await Promise.all(batch.map(tu => this._attemptTool(ctx, tu, tac.signal)));
      const toolResults = settled.map((s, i) => {
        const r = this._finishToolStep(runId, stepNos[i], batch[i], s, tac.signal);
        if (r.status === "aborted") abortedMidway = true;
        return r.toolResult;
      });
      return { toolResults, abortedMidway };
    } finally {
      this._releaseAbort(runId, tac);
    }
  }

  _getAnchorUserText() {
    // Latest (not first) user text = the current run's request (first-message anchor misdirects follow-ups).
    for (const row of this.sql.exec(
      "SELECT content FROM messages WHERE role = 'user' ORDER BY seq DESC",
    )) {
      const blocks = parseJson(row.content);
      if (!blocks) continue;
      if (!Array.isArray(blocks)) continue;
      const text = extractText(blocks);
      if (!text) continue;
      if (isInternalMarker(text)) continue;
      return text;
    }
    return null;
  }

  _buildLlmMessages(opts = {}) {
    const { maxMessages = null } = opts;
    // Bounded tail read (<= maxMessages, 2x+slack for stripTools) keeps assembly O(maxMessages), not O(n^2).
    const rows = typeof maxMessages === "number"
      ? [...this.sql.exec(
          "SELECT role, content FROM messages ORDER BY seq DESC LIMIT ?", maxMessages * 2 + 16,
        )].reverse()
      : [...this.sql.exec("SELECT role, content FROM messages ORDER BY seq")];
    const raw = rows.map(row => {
      let content;
      try { content = JSON.parse(row.content); }
      catch { content = [{ type: "text", text: row.content }]; }
      return { role: row.role, content };
    });
    return windowLlmMessages(raw, opts);
  }

  _nextStepNo(runId) {
    const row = firstRow(this.sql.exec(
      "SELECT MAX(step_no) AS m FROM steps WHERE run_id = ?", runId,
    ));
    return Number.isInteger(row?.m) ? row.m + 1 : 0;
  }

  _insertStep(runId, stepNo, kind, input) {
    this.sql.exec(
      "INSERT INTO steps (run_id, step_no, kind, input, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
      runId, stepNo, kind, JSON.stringify(input ?? null), Date.now(),
    );
  }

  _completeStep(runId, stepNo, output, status) {
    this.sql.exec(
      "UPDATE steps SET output = ?, status = ?, ended_at = ? WHERE run_id = ? AND step_no = ?",
      JSON.stringify(output ?? null), status, Date.now(), runId, stepNo,
    );
  }

  // Returns true if it settled the run, false if already terminal (terminal-idempotent).
  _endRun(runId, status, error, stopReason) {
    const cur = firstRow(this.sql.exec("SELECT status FROM runs WHERE run_id = ?", runId));
    if (cur && isTerminalRunStatus(cur.status)) return false;
    const errStr = (error == null) ? null : (typeof error === "string" ? error : String(error?.message ?? error));
    const stopReasonStr = (typeof stopReason === "string" && stopReason.length > 0) ? stopReason : null;
    this.sql.exec(
      "UPDATE runs SET status = ?, ended_at = ?, error = ?, stop_reason = ? WHERE run_id = ?",
      status, Date.now(), errStr, stopReasonStr, runId,
    );
    this.sql.exec(
      "UPDATE steps SET status = 'aborted', ended_at = ? WHERE run_id = ? AND status = 'running'",
      Date.now(), runId,
    );
    return true;
  }

  _expiredNow() {
    const exp = Number(this._readMeta("expiresAt"));
    return Number.isFinite(exp) && exp > 0 && Date.now() >= exp;
  }

  // Deadline crossing only cancels the run — full teardown (VM, catalog) stays with the router's
  // expireSession on next access, and the broker's 6h max lifetime backstops the VM.
  _cancelIfExpired(runId) {
    if (!this._expiredNow()) return false;
    this._cancelRun(runId, "expired");
    return true;
  }

  _isCancelled(runId) {
    const row = firstRow(this.sql.exec(
      "SELECT cancel_requested FROM runs WHERE run_id = ?", runId,
    ));
    if (row?.cancel_requested) return true;
    return this._cancelIfExpired(runId);
  }

  _sanitizeLlmResponse(resp) {
    if (!resp || typeof resp !== "object") return resp;
    const { id, model, role, stop_reason, stop_sequence, usage, content } = resp;
    return { id, model, role, stop_reason, stop_sequence, usage, contentBlockCount: Array.isArray(content) ? content.length : 0 };
  }

  _buildToolCtx() {
    return {
      env: this.env,
      sessionId: this._readMeta("ns"),  // sandbox/agent session id = ns (letter-leading project dir); chat id stays the random bearer
      ns: this._readMeta("ns"),
      nsToken: this._readMeta("nsToken"),
      endpoint: this._readMeta("microvmEndpoint"),
      authToken: this._readMeta("microvmAuthToken"),
      language: this._lang(),
      previewUrl: () => this._readMeta("previewUrl"),
      setPreviewUrl: (url) => this._writeMeta("previewUrl", url),
    };
  }

  // Open the session MicroVM on first tool use; single-flighted so a concurrent caller can't orphan a second VM.
  async _ensureSandbox() {
    return this._coalesce(this._ensureInFlight, "ensure", () => this._ensureSandboxOnce());
  }

  async _ensureSandboxOnce() {
    if (this._readMeta("closed")) throw httpError(409, "session closed");
    const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
    const microvmId = this._readMeta("microvmId");
    if (microvmId) {
      const exp = Number(this._readMeta("microvmAuthExp") ?? 0);
      if (Number.isFinite(exp) && exp - Date.now() >= TOKEN_REFRESH_MARGIN_MS) return;
      try {
        const t = await this.env.BROKER.mintToken({ microvmId });
        this._writeMeta("microvmAuthToken", t.authToken);
        this._writeMeta("microvmAuthExp", String(t.expiresAt ?? 0));
        return;
      } catch (err) {
        // Only 404 = broker reclaimed the VM; a transient AWS error must NOT discard a live VM — rethrow.
        if (!/-> 404:/.test(errMessage(err))) throw err;
        // Genuine reclaim: VM + /workspace gone — drop the handle and clear workspace-local state.
        this._writeMeta("microvmId", "");
        this._writeMeta("microvmEndpoint", "");
        this._writeMeta("microvmAuthToken", "");
        this._writeMeta("assets", "");
      }
    }
    const res = await this.env.BROKER.openSession({
      sessionId: this._readMeta("ns"),  // sandbox/agent session id = ns (letter-leading project dir); chat id stays the random bearer
      ns: this._readMeta("ns"),
      adminUrl: this.env.ADMIN_URL ?? "",
      nsToken: this._readMeta("nsToken"),
    });
    if (this._readMeta("closed")) {
      // A close raced this first open — reap the VM we just created so it isn't orphaned.
      try { await this.env.BROKER.closeSession({ microvmId: res.microvmId }); } catch { /* best effort */ }
      throw httpError(409, "session closed");
    }
    this._writeMeta("microvmId", res.microvmId);
    this._writeMeta("microvmEndpoint", res.endpoint);
    this._writeMeta("microvmAuthToken", res.authToken);
    this._writeMeta("microvmAuthExp", String(res.authTokenExpiresAt ?? 0));
  }

  // GET /export — stream the session project tree (gzipped tar) to the browser.
  async _handleExport() {
    if (!this._readMeta("microvmId")) return jsonResponse(409, { error: "nothing to export yet" });
    try { await this._ensureSandbox(); }
    catch (err) { console.warn(`sandbox open failed: ${errMessage(err)}`); return jsonResponse(503, { error: "sandbox unavailable" }); }
    const endpoint = this._readMeta("microvmEndpoint");
    const authToken = this._readMeta("microvmAuthToken");
    const ns = this._readMeta("ns");
    let res;
    try {
      res = await fetch(`https://${endpoint}/export?sessionId=${encodeURIComponent(ns)}`, {
        headers: { "X-aws-proxy-auth": authToken },
        signal: AbortSignal.timeout(EXPORT_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return jsonResponse(502, { error: `export fetch failed: ${errMessage(err)}` });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return jsonResponse(res.status, { error: `export upstream ${res.status}`, detail: detail.slice(0, 300) });
    }
    return new Response(res.body, {
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/gzip",
        "content-disposition": res.headers.get("content-disposition") ?? `attachment; filename="${ns}-workspace.tar.gz"`,
      },
    });
  }

  // POST /upload — write user materials (multipart) to ./assets on the MicroVM.
  async _handleUpload(req) {
    const declaredLen = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_TOTAL_BYTES + (1 << 20)) {
      return jsonResponse(413, { error: `upload total too large (max ${MAX_UPLOAD_TOTAL_BYTES} bytes)` });
    }
    let form;
    try { form = await req.formData(); }
    catch { return jsonResponse(400, { error: "expected multipart/form-data" }); }
    const entries = form.getAll("files").filter(f => f && typeof f.arrayBuffer === "function");
    if (entries.length === 0) return jsonResponse(400, { error: "no files" });
    if (entries.length > MAX_UPLOAD_FILES) return jsonResponse(413, { error: `too many files (max ${MAX_UPLOAD_FILES})` });

    const files = [];
    const usedNames = new Set();
    let total = 0;
    for (const f of entries) {
      const buf = await f.arrayBuffer();
      if (buf.byteLength > MAX_UPLOAD_FILE_BYTES) {
        return jsonResponse(413, { error: `file too large: ${safeUploadName(f.name)} (max ${MAX_UPLOAD_FILE_BYTES} bytes)` });
      }
      total += buf.byteLength;
      if (total > MAX_UPLOAD_TOTAL_BYTES) {
        return jsonResponse(413, { error: `upload total too large (max ${MAX_UPLOAD_TOTAL_BYTES} bytes)` });
      }
      const name = uniqueUploadName(safeUploadName(f.name), usedNames);
      usedNames.add(name);
      files.push({ name, contentBase64: bytesToBase64(buf) });
    }

    try { await this._ensureSandbox(); }
    catch (err) { console.warn(`sandbox open failed: ${errMessage(err)}`); return jsonResponse(503, { error: "sandbox unavailable" }); }
    const ctx = this._buildToolCtx();
    const results = [];
    const stored = [];
    for (const f of files) {
      const r = await uploadAsset(ctx, f.name, f.contentBase64);
      if (r?.error) results.push({ name: f.name, error: r.error });
      else { results.push({ name: f.name, bytes: r.bytes ?? null }); stored.push(f.name); }
    }
    if (stored.length) this._recordAssets(stored);
    return jsonResponse(200, { ok: results.every(r => !r.error), files: results });
  }

  _readAssets() {
    const raw = this._readMeta("assets");
    if (!raw) return [];
    const a = parseJson(raw);
    return Array.isArray(a) ? a.filter(x => typeof x === "string") : [];
  }

  _recordAssets(names) {
    const set = new Set(this._readAssets());
    for (const n of names) set.add(n);
    // Keep only the most recent MAX_ASSETS_INDEX so repeated uploads can't bloat DO metadata or the
    // system prompt; the files still live in ./assets and the prompt tells the agent to list_files.
    const arr = [...set];
    this._writeMeta("assets", JSON.stringify(arr.length > MAX_ASSETS_INDEX ? arr.slice(-MAX_ASSETS_INDEX) : arr));
  }

  _writeMeta(key, value) {
    this.sql.exec(
      "INSERT INTO session_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  _readMeta(key) {
    const row = firstRow(this.sql.exec("SELECT value FROM session_meta WHERE key = ?", key));
    return row?.value ?? null;
  }

  _lang() {
    return this._readMeta("lang") === "zh" ? "zh" : "en";
  }

  _nextSeq() {
    const row = firstRow(this.sql.exec("SELECT MAX(seq) AS m FROM messages"));
    const max = row?.m;
    return Number.isInteger(max) ? max + 1 : 0;
  }

  _broadcast(eventName, payload) {
    if (this.subscribers.size > 0) {
      const bytes = SSE_ENCODER.encode(sseEvent(eventName, payload));
      for (const ctl of this.subscribers) {
        try { ctl.enqueue(bytes); } catch { this.subscribers.delete(ctl); }
      }
    }
    const sockets = this.state.getWebSockets();
    if (sockets.length > 0) {
      const wsFrame = JSON.stringify({ event: eventName, data: payload });
      for (const ws of sockets) {
        try { ws.send(wsFrame); } catch { /* close handler cleans up */ }
      }
    }
  }

  _emitReplay(emit) {
    const recent = [...this.sql.exec(
      "SELECT seq, role, content, created_at FROM messages ORDER BY seq DESC LIMIT ?",
      HISTORY_REPLAY_LIMIT,
    )].reverse();
    for (const row of recent) {
      let content;
      try { content = JSON.parse(row.content); } catch { content = row.content; }
      if (row.role === "user" && isInternalMarker(extractText(Array.isArray(content) ? content : []))) continue;
      if (row.role === "assistant" && this._isPlanDraftSeq(row.seq)) continue;
      emit(
        row.role === "user" ? "message.user" : "message.assistant",
        { seq: row.seq, role: row.role, content, createdAt: row.created_at, replay: true },
      );
    }
    emit("history.done", {
      replayed: recent.length,
      lang: this._lang(),
      ns: this._readMeta("ns"),
      // lets a client without the localStorage copy (cross-device hash resume) learn the countdown deadline
      expiresAt: Number(this._readMeta("expiresAt")) || null,
    });
    // Use the NEWEST run by start time (a superseded 'running' run can linger after a newer one finished).
    const newest = firstRow(this.sql.exec(
      "SELECT run_id, status, error, cancel_reason, stop_reason FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ));
    let terminalRunId = null, runStatus = null, runError = null, runCancelReason = null, runStopReason = null;
    if (newest && !isTerminalRunStatus(newest.status)) {
      const activeRunId = newest.run_id;
      // Parked at plan (no successor step) => drafting, else running — sets the replayed mode.
      const lastPlanStep = firstRow(this.sql.exec(
        "SELECT step_no, kind FROM steps WHERE run_id = ? AND kind IN ('plan_draft', 'plan_revise') AND status = 'done' ORDER BY step_no DESC LIMIT 1",
        activeRunId,
      ));
      const laterStep = lastPlanStep ? firstRow(this.sql.exec(
        "SELECT step_no FROM steps WHERE run_id = ? AND step_no > ? LIMIT 1",
        activeRunId, lastPlanStep.step_no,
      )) : null;
      const lastMsg = this._lastMessage();
      const parkedAtPlan = Boolean(lastPlanStep && !laterStep && lastMsg?.role === "assistant");
      emit("run.scheduled", { runId: activeRunId, replay: true, mode: parkedAtPlan ? "plan_confirmed" : "free_form" });
      if (parkedAtPlan) {
        const planMsg = lastMsg; // parkedAtPlan means the newest row IS this assistant plan message
        if (planMsg) {
          try {
            const planText = extractText(JSON.parse(planMsg.content));
            if (planText) {
              emit("plan.draft", {
                runId: activeRunId,
                kind: lastPlanStep.kind,
                plan: planText,
                attempt: Number(this._readMeta("planAwaitAttempt:" + activeRunId) || "0"),
                replay: true,
              });
            }
          } catch { /* ignore parse failure */ }
        }
      }
    } else if (newest) {
      terminalRunId = newest.run_id;
      runStatus = newest.status;
      runError = newest.error;
      runCancelReason = newest.cancel_reason;
      runStopReason = newest.stop_reason;
    }
    if (runStatus) {
      const payload = { runId: terminalRunId, replay: true };
      if (runError != null) payload.error = runError;
      if (runCancelReason != null) payload.reason = runCancelReason;
      if (runStopReason != null) payload.stop_reason = runStopReason;
      emit(`run.${runStatus}`, payload);
    }
    const lastDeploy = firstRow(this.sql.exec(
      `SELECT output FROM steps
         WHERE status = 'done' AND kind = 'tool_call' AND input LIKE '%"deploy_test"%'
      ORDER BY started_at DESC LIMIT 1`,
    ));
    if (lastDeploy?.output) {
      try {
        const out = JSON.parse(lastDeploy.output);
        if (out?.previewUrl && out?.versionId) {
          emit("preview.ready", {
            versionId: out.versionId,
            previewUrl: out.previewUrl,
            artifactMeta: out.artifactMeta ?? null,
            replay: true,
          });
        }
      } catch { /* ignore */ }
    }
  }

  _handleWebSocketUpgrade() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this._emitReplay((event, data) => {
      try { server.send(JSON.stringify({ event, data })); } catch { /* peer gone */ }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  _handleStream() {
    const subs = this.subscribers;
    let controller;
    let heartbeatTimer = null;
    const stream = new ReadableStream({
      start: c => {
        controller = c;
        subs.add(c);
        this._emitReplay((event, data) => {
          c.enqueue(SSE_ENCODER.encode(sseEvent(event, data)));
        });
        // Heartbeat keeps the SSE stream alive through idle timeouts.
        heartbeatTimer = setInterval(() => {
          try { c.enqueue(SSE_ENCODER.encode(": hb\n\n")); }
          catch { clearInterval(heartbeatTimer); subs.delete(c); }
        }, 25_000);
      },
      cancel: () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        subs.delete(controller);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }
}

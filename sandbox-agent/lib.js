import path from "node:path";

export const WORKSPACE = "/workspace";
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Sandbox boundary is the VM + uid, not env secrecy: ADMIN_TOKEN is merged into AI child env and is AI-visible by design.
export const SANDBOX_USER = { uid: 2000, name: "sandbox" };

export function httpErr(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details && typeof details === "object") err.details = details;
  return err;
}

export function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw httpErr(400, "sessionId must match [a-zA-Z0-9_-]{1,64}");
  }
  return sessionId;
}

export function sessionDir(sessionId) {
  return `${WORKSPACE}/${validateSessionId(sessionId)}`;
}

// HOME must be a sibling of the project dir, not inside it, or `wdl init .` refuses the non-empty dir.
export function sessionHomeDir(sessionId) {
  return `${sessionDir(sessionId)}.home`;
}

export function resolveWorkspacePath(userPath, sessionId) {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw httpErr(400, "path required");
  }
  const sdir = sessionDir(sessionId);

  let rel = userPath;
  if (rel === WORKSPACE) rel = "";
  else if (rel.startsWith(`${WORKSPACE}/`)) rel = rel.slice(WORKSPACE.length + 1);
  else if (rel.startsWith("/")) {
    throw httpErr(400, `path escapes ${WORKSPACE}`);
  }

  const abs = path.resolve(sdir, rel);
  if (abs !== sdir && !abs.startsWith(`${sdir}${path.sep}`)) {
    throw httpErr(400, `path escapes ${WORKSPACE}`);
  }
  const presented = abs === sdir ? WORKSPACE : `${WORKSPACE}${abs.slice(sdir.length)}`;
  return { abs, presented, root: sdir };
}

// Read-only allowlist outside /workspace; writes never use this.
const READONLY_ABS_PREFIXES = ["/opt/wdl-cli/docs", "/opt/wdl-cli/examples"];

export function resolveReadablePath(userPath, sessionId) {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw httpErr(400, "path required");
  }
  if (userPath.startsWith("/opt/")) {
    const abs = path.resolve(userPath);
    for (const pre of READONLY_ABS_PREFIXES) {
      if (abs === pre || abs.startsWith(`${pre}${path.sep}`)) {
        return { abs, presented: abs, root: pre };
      }
    }
    throw httpErr(400, `path escapes ${WORKSPACE}`);
  }
  return resolveWorkspacePath(userPath, sessionId);
}

export function appendCapped(prev, chunk, cap) {
  const room = cap - prev.length;
  if (room <= 0) return { value: prev, truncated: true };
  if (chunk.length <= room) return { value: prev + chunk, truncated: false };
  return { value: prev + chunk.slice(0, room), truncated: true };
}

// Accumulate streamed chunks up to `cap` chars; wire onData to a stream's "data".
export function makeCappedSink(cap) {
  let value = "";
  let truncated = false;
  let flushed = false;
  // Stream-decode so a multibyte UTF-8 char split across chunks isn't corrupted to U+FFFD.
  const decoder = new TextDecoder();
  return {
    onData(chunk) {
      const r = appendCapped(value, decoder.decode(chunk, { stream: true }), cap);
      value = r.value;
      truncated = truncated || r.truncated;
    },
    get value() {
      if (!flushed) {
        flushed = true;
        const tail = decoder.decode();  // surface any trailing incomplete sequence
        if (tail) { const r = appendCapped(value, tail, cap); value = r.value; truncated = truncated || r.truncated; }
      }
      return value;
    },
    get truncated() { return truncated; },
  };
}

const PASSTHROUGH_ENV_KEYS = ["PATH", "WDL_CLI_LOCAL_PATH", "WDL_DEPLOY_ENV"];
// Caller cannot override these; HOME caller-supplied would break per-session isolation.
const SYSTEM_ENV_KEYS = new Set(["HOME", "NODE_ENV", "WRANGLER_SEND_METRICS"]);

export function buildChildEnv(extra, processEnv, homeDir = WORKSPACE) {
  const out = {};
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v !== "string") continue;
      if (SYSTEM_ENV_KEYS.has(k)) continue;
      out[k] = v;
    }
  }
  if (processEnv) {
    for (const k of PASSTHROUGH_ENV_KEYS) {
      if (typeof processEnv[k] === "string") out[k] = processEnv[k];
    }
  }
  out.HOME = homeDir;
  out.NODE_ENV = "development";
  out.WRANGLER_SEND_METRICS = "false";
  // Shim force-exits after the dry-run bundle is written so wrangler's lingering keep-alive sockets can't stall pack.
  out.WDL_WRANGLER_BIN = "/opt/sandbox-agent/scripts/wrangler-shim.mjs";
  out.NO_UPDATE_NOTIFIER = "1";
  return out;
}

// Per-key readers-writer lock; 503 on acquire-timeout.
export function makeKeyedRwLock(acquireTimeoutMs = 5000) {
  const ks = new Map();
  function entry(key) {
    let e = ks.get(key);
    if (!e) { e = { writeTail: Promise.resolve(), reads: new Set(), pending: 0 }; ks.set(key, e); }
    return e;
  }
  function done(key, e) {
    e.pending -= 1;
    if (e.pending === 0 && ks.get(key) === e) ks.delete(key);
  }
  async function waitOr503(p) {
    let timer;
    try {
      await Promise.race([
        p.catch(() => {}),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(httpErr(503, "sandbox busy (mutex wait timeout)")), acquireTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function write(key, fn) {
    const e = entry(key);
    e.pending += 1;
    const prevWrite = e.writeTail;
    const priorReads = [...e.reads];
    let release;
    e.writeTail = new Promise(resolve => { release = resolve; });
    return (async () => {
      try {
        await waitOr503(Promise.all([prevWrite, ...priorReads]));
      } catch (err) {
        Promise.all([prevWrite, ...priorReads]).catch(() => {}).finally(() => { release(); done(key, e); });
        throw err;
      }
      try { return await fn(); }
      finally { release(); done(key, e); }
    })();
  }

  function read(key, fn) {
    const e = entry(key);
    e.pending += 1;
    const waitFor = e.writeTail;
    let finishRead;
    const rp = new Promise(resolve => { finishRead = resolve; });
    e.reads.add(rp);
    return (async () => {
      try {
        await waitOr503(waitFor);
      } catch (err) {
        finishRead();
        e.reads.delete(rp);
        done(key, e);
        throw err;
      }
      try { return await fn(); }
      finally { finishRead(); e.reads.delete(rp); done(key, e); }
    })();
  }

  return { read, write };
}

export function parseTimeoutSec(value, defaultSec) {
  if (value === undefined || value === null) return defaultSec;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 600) {
    throw httpErr(400, "timeoutSec must be 1..600");
  }
  return n;
}

// security: sanitize ns to a safe Content-Disposition filename ([A-Za-z0-9_-] only; blocks header injection).
export function exportFilename(ns) {
  const safe = (typeof ns === "string" ? ns : "").replace(/[^a-zA-Z0-9_-]/g, "");
  return `${safe || "workspace"}-workspace.tar.gz`;
}

// tar --exclude patterns for a workspace export. Excludes local secret files (.env*, .dev.vars*) so
// an export download can't leak Wrangler local credentials.
// Basename patterns (no leading ./) so tar excludes these at ANY depth, not just the workspace root
// — nested secrets (apps/web/.env.local, sub/.dev.vars) must not ship in the export.
export const EXPORT_EXCLUDES = [
  "node_modules", ".git", ".deploy-dist", ".wrangler",
  ".env", ".env.*", ".dev.vars", ".dev.vars.*",
];

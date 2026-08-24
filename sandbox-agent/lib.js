import path from "node:path";
import { promises as fs, constants as FS } from "node:fs";
import { randomUUID } from "node:crypto";

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

// Walk root → dir, opening each component O_NOFOLLOW through the parent's pinned fd, and return the
// leaf directory's FileHandle. Every lookup targets a pinned inode, so a path component the sandbox
// uid swaps concurrently can't redirect an operation the caller then runs relative to the returned
// fd. The caller closes it. root must be an anchor the sandbox uid can't swap — WORKSPACE and the
// session dir both qualify, their parents being root-owned. A symlinked or regular-file component
// fails ENOTDIR (O_DIRECTORY + O_NOFOLLOW rejects both as "not a directory" before ELOOP fires).
//
// With mkdir: true each missing component is created first (and chowned to ownerUid when set),
// still through the parent's pinned fd — the mkdir -p counterpart. Deliberately the ONLY
// implementation of this walk: a hardening applied to a forked copy misses the other.
export async function openConfinedDir(dir, root, { mkdir = false, ownerUid = null } = {}) {
  const rel = path.relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw httpErr(400, "path escapes workspace");
  let dirFd = await fs.open(root, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  if (rel === "") return dirFd;
  try {
    for (const part of rel.split(path.sep)) {
      if (part === "" || part === "." || part === "..") throw httpErr(400, "path escapes workspace");
      const at = `/proc/self/fd/${dirFd.fd}/${part}`;
      if (mkdir) {
        try { await fs.mkdir(at); } catch (e) { if (e?.code !== "EEXIST") throw e; }
      }
      const child = await fs.open(at, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
      // Until child becomes dirFd the outer catch can't see it, so a failing chown (EROFS, id-map
      // errors) must close it here; the parent's own close failure is inert and must not leak it either.
      try {
        if (mkdir && ownerUid != null) await child.chown(ownerUid, ownerUid); // fchown the pinned inode — never a re-walked pathname
      } catch (err) {
        await child.close().catch(() => {});
        throw err;
      }
      await dirFd.close().catch(() => {});
      dirFd = child;
    }
    return dirFd;
  } catch (err) {
    await dirFd.close().catch(() => {});
    throw err;
  }
}

// Open `name` for reading inside the pinned dir fd, as the /edit-file source. Confinement is the dir
// fd itself — the lookup can't leave the pinned inode. O_NOFOLLOW refuses a leaf symlink (ELOOP; the
// edit feeds a write-back, so unlike /read-file it must not follow), O_NONBLOCK stops a writer-less
// FIFO wedging the open while the session write lock is held, and a regular-file check rejects the rest.
export async function openRegularFileAt(dirFd, name) {
  const fh = await fs.open(`/proc/self/fd/${dirFd.fd}/${name}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw httpErr(400, "not a regular file");
    return { fh, st };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

// The textual half of /edit-file, split out so it is testable without a session or a real fd.
// split/join rather than String.replace: a newStr containing $& or $1 would otherwise be read as a
// replacement pattern. With found === 1 the join is exactly the single-replacement case.
// Ill-formed needles are refused up front: a lone-surrogate oldStr can match half an emoji, and
// the byte arithmetic below is only exact when every split part is well-formed (a lone surrogate
// encodes as 3 bytes where the intact pair had 4). content itself is always well-formed — it
// arrives via a fatal UTF-8 decode.
export function applyEdit(content, oldStr, newStr, replaceAll, maxBytes = Infinity) {
  if (!oldStr.isWellFormed() || !newStr.isWellFormed()) return { illFormed: true };
  const parts = content.split(oldStr);
  const found = parts.length - 1;
  if (found === 0) return { found: 0 };
  if (found > 1 && !replaceAll) return { found, ambiguous: true };
  // Size the result by arithmetic BEFORE joining: a replace_all that grows each match would
  // otherwise have to build the oversized string in order to measure it. UTF-8 lengths are additive,
  // so this is exact, and the source cap alone does not bound it (small file, huge newStr, N matches).
  const bytes = Buffer.byteLength(content)
    + found * (Buffer.byteLength(newStr) - Buffer.byteLength(oldStr));
  if (bytes > maxBytes) return { found, oversize: true, bytes };
  return { found, bytes, text: parts.join(newStr) };
}

// Atomically replace `name` inside the pinned dir fd. Stage a sibling temp, then rename over the
// target: rename is atomic, so a failure before it leaves the existing file exactly as it was
// (truncate-then-write would destroy it on a short write or ENOSPC). Both the staging create and the
// rename resolve through /proc/self/fd/<dirFd> — the pinned directory inode — so a parent component
// the sandbox uid swaps to a symlink mid-request cannot redirect this root write outside the
// workspace; a raw pathname rename re-walks that mutable parent and can. writeFile handles a short
// write a lone fh.write() would not; chmod re-sets the mode open() masked by umask; uid/gid carry
// over since rename swaps the inode. Staging name omits `name` so a 255-byte basename + uuid can't
// hit ENAMETOOLONG; the uuid alone is unique.
export async function replaceFileAtomically(dirFd, name, text, { mode, uid, gid }) {
  const base = `/proc/self/fd/${dirFd.fd}`;
  const tmp = `${base}/.edit-${randomUUID()}.tmp`;
  let fh = null;
  try {
    fh = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, mode);
    await fh.writeFile(text);
    await fh.chown(uid, gid);
    await fh.chmod(mode);
    await fh.close();
    fh = null;
    await fs.rename(tmp, `${base}/${name}`);
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

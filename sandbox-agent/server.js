import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs, constants as FS, createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE,
  SANDBOX_USER,
  appendCapped,
  buildChildEnv,
  EXPORT_EXCLUDES,
  exportFilename,
  httpErr,
  makeCappedSink,
  makeKeyedRwLock,
  parseTimeoutSec,
  resolveReadablePath,
  resolveWorkspacePath,
  sessionDir,
  sessionHomeDir,
  validateSessionId,
} from "./lib.js";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_OUTPUT = 5 * 1024 * 1024;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_READ_FILE_BYTES = 256 * 1024;   // read_file head cap (tool_result is 256KB-capped downstream anyway)
const MAX_LIST_ENTRIES = 1000;
const PACK_TIMEOUT_MS = 60_000;
// Inbound traffic is JWE-authed by the Lambda proxy; agent does no token check.

const sessionLock = makeKeyedRwLock();

// One MicroVM == one session; null until broker POSTs /init.
let session = null; // { sessionId, ns, adminUrl, nsToken }

const packInFlight = new Map();
function coalescedPackage(sid) {
  const existing = packInFlight.get(sid);
  if (existing) return existing;
  const run = sessionLock.write(sid, () => handlePackage(sid))
    .finally(() => { if (packInFlight.get(sid) === run) packInFlight.delete(sid); });
  packInFlight.set(sid, run);
  return run;
}

function requireSession(claimedSessionId) {
  if (!session) throw httpErr(412, "session not initialized; awaiting POST /init");
  if (claimedSessionId != null && claimedSessionId !== session.sessionId) {
    throw httpErr(409, "sessionId does not match this MicroVM's session");
  }
  return session;
}

// fs.* follow symlinks and the agent is root; realpath-confine so an AI-planted symlink can't redirect a root op outside root.
async function realWithin(p, root) {
  const real = await fs.realpath(p);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw httpErr(400, `path escapes ${WORKSPACE}`);
  }
  return real;
}

// mkdir -p, fully confined: each component is created and reopened through the PARENT's pinned dir fd
// (/proc/self/fd/<fd>) with O_NOFOLLOW. Every op targets a pinned inode, so a concurrently-swapped
// path component can neither redirect the root mkdir outside the workspace nor be followed as a symlink.
async function mkdirWithinConfined(targetDir, root) {
  const rel = path.relative(root, targetDir);
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw httpErr(400, "path escapes workspace");
  let dirFd = await fs.open(root, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  try {
    for (const part of rel.split(path.sep)) {
      if (part === "" || part === "." || part === "..") throw httpErr(400, "path escapes workspace");
      const at = `/proc/self/fd/${dirFd.fd}/${part}`;
      try { await fs.mkdir(at); } catch (e) { if (e?.code !== "EEXIST") throw e; }
      const childFd = await fs.open(at, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW); // O_NOFOLLOW: part must be a real dir, not a symlink
      await dirFd.close();
      dirFd = childFd;
    }
  } finally {
    await dirFd.close();
  }
}

function spawnAndCollect(args, { timeoutMs } = {}) {
  return new Promise(resolve => {
    const child = spawn(args[0], args.slice(1), {
      cwd: WORKSPACE,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errSink = makeCappedSink(MAX_OUTPUT);
    child.stderr.on("data", errSink.onData);
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", err => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: -1, error: err.message, stderr: errSink.value, stderrTruncated: errSink.truncated });
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stderr: errSink.value, stderrTruncated: errSink.truncated });
    });
  });
}

async function ensureSessionDirs(sessionId) {
  const { uid } = SANDBOX_USER;
  for (const dir of [sessionDir(sessionId), sessionHomeDir(sessionId)]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o700);
    await fs.chown(dir, uid, uid);
  }
}

async function handleInit(body) {
  const sessionId = validateSessionId(body?.sessionId);
  if (session && session.sessionId !== sessionId) {
    throw httpErr(409, "MicroVM already bound to a different session");
  }
  await ensureSessionDirs(sessionId);
  session = {
    sessionId,
    ns: typeof body.ns === "string" ? body.ns : sessionId,
    adminUrl: typeof body.adminUrl === "string" ? body.adminUrl : "",
    nsToken: typeof body.nsToken === "string" ? body.nsToken : "",
  };
  console.log(`session initialized: ${sessionId}`);
  return { ok: true, sessionId };
}

// Self-enforced cap: the VM is a public endpoint, so don't trust chat-worker's clamp.
const RUN_COMMAND_MAX_SEC = 45;
async function handleRun(body) {
  const cmd = body?.cmd;
  if (typeof cmd !== "string" || cmd.length === 0) throw httpErr(400, "cmd required");
  const timeoutSec = Math.min(parseTimeoutSec(body?.timeoutSec, RUN_COMMAND_MAX_SEC), RUN_COMMAND_MAX_SEC);
  const s = requireSession(body?.sessionId);
  const { name: userName } = SANDBOX_USER;
  const sdir = sessionDir(s.sessionId);
  const hdir = sessionHomeDir(s.sessionId);
  const childEnv = buildChildEnv(
    { WDL_NS: s.ns, CONTROL_URL: s.adminUrl, ADMIN_TOKEN: s.nsToken },
    process.env, hdir,
  );

  return new Promise(resolve => {
    const started = Date.now();
    // Override gosu's HOME to the per-session sibling so dotfiles don't trip `wdl init`'s emptiness check.
    // detached → child leads its own process group so a timeout SIGKILLs the whole group; else backgrounded grandchildren hold stdout open and wedge the lock.
    const child = spawn("gosu", [userName, "env", `HOME=${hdir}`, "/bin/bash", "-c", cmd], {
      cwd: sdir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const outSink = makeCappedSink(MAX_OUTPUT);
    const errSink = makeCappedSink(MAX_OUTPUT);
    child.stdout.on("data", outSink.onData);
    child.stderr.on("data", errSink.onData);
    let timedOut = false;
    let settled = false;
    let graceTimer = null;
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, timeoutSec * 1000);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        timedOut,
        stdout: outSink.value, stdoutTruncated: outSink.truncated,
        stderr: errSink.value, stderrTruncated: errSink.truncated,
        durationMs: Date.now() - started,
        ...extra,
      });
    };
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
    // 'close' waits for ALL stdio; an escaped descendant can hold the pipe open and wedge the lock — force-resolve shortly after the child exits.
    child.on("exit", (code, signal) => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => {
        try { child.stdout.destroy(); } catch { /* ignore */ }
        try { child.stderr.destroy(); } catch { /* ignore */ }
        finish({ exitCode: code, signal, pipesLeaked: true });
      }, 2000);
    });
    child.on("error", err => finish({
      exitCode: -1, signal: null,
      stderr: errSink.value + `\n[spawn error] ${err.message}`,
    }));
  });
}

async function handleWriteFile(body) {
  const s = requireSession(body?.sessionId);
  const { uid } = SANDBOX_USER;
  const { abs, presented, root: sdir } = resolveWorkspacePath(body?.path, s.sessionId);
  if (typeof body?.content !== "string") throw httpErr(400, "content must be a string");
  const base64 = body?.encoding === "base64";
  const buf = base64 ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8");
  await mkdirWithinConfined(path.dirname(abs), sdir);
  const realDir = await realWithin(path.dirname(abs), sdir);
  const target = path.join(realDir, path.basename(abs));
  // TOCTOU guard: O_NOFOLLOW (leaf) + O_EXCL + fd-realpath re-check inside the session dir; unlink a file a redirected open created outside the workspace.
  let fh, created = false;
  try {
    fh = await fs.open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644);
    created = true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const st = await fs.lstat(target);
    if (!st.isFile()) throw httpErr(400, "target exists and is not a regular file");
    fh = await fs.open(target, FS.O_WRONLY | FS.O_NOFOLLOW, 0o644);
  }
  try {
    const openedReal = await fs.realpath(`/proc/self/fd/${fh.fd}`);
    if (openedReal !== sdir && !openedReal.startsWith(sdir + path.sep)) {
      if (created) await fs.unlink(openedReal).catch(() => {});
      throw httpErr(400, "path escapes workspace");
    }
    await fh.truncate(0);
    await fh.write(buf, 0, buf.length, 0);
  } finally { await fh.close(); }
  // lchown/lstat (never chown/stat) so ownership never traverses a symlink.
  const ownershipWarnings = [];
  try {
    await fs.lchown(target, uid, uid);
  } catch (err) {
    ownershipWarnings.push(`lchown ${target}: ${err?.message ?? err}`);
  }
  let dir = realDir;
  while (dir.startsWith(sdir) && dir !== sdir) {
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat) break;
    if (stat.uid !== uid) {
      try {
        await fs.lchown(dir, uid, uid);
      } catch (err) {
        ownershipWarnings.push(`lchown ${dir}: ${err?.message ?? err}`);
      }
    }
    dir = path.dirname(dir);
  }
  const result = { ok: true, path: presented, bytes: buf.length };
  if (ownershipWarnings.length > 0) {
    console.warn(`/write-file ${target}: chown failures`, ownershipWarnings);
    result.ownershipFixed = false;
    result.warnings = ownershipWarnings;
  }
  return result;
}

async function handleReadFile(query) {
  const s = requireSession(query.sessionId);
  const { abs, presented, root } = resolveReadablePath(query.path, s.sessionId);
  const realRoot = await fs.realpath(root);
  // O_NONBLOCK so a FIFO can't wedge the open; confine by the opened fd's realpath (reflects where the
  // fd actually landed) — atomic with the open, so a post-check symlink swap can't redirect the read.
  const fh = await fs.open(abs, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    const opened = await fs.realpath(`/proc/self/fd/${fh.fd}`);
    if (opened !== realRoot && !opened.startsWith(`${realRoot}${path.sep}`)) {
      throw httpErr(400, `path escapes ${WORKSPACE}`);
    }
    const st = await fh.stat();
    if (!st.isFile()) throw httpErr(400, "not a regular file");
    const cap = Math.min(st.size, MAX_READ_FILE_BYTES);
    const buf = Buffer.alloc(cap);
    if (cap > 0) await fh.read(buf, 0, cap, 0);
    return { path: presented, content: buf.toString("utf8"), truncated: st.size > MAX_READ_FILE_BYTES };
  } finally {
    await fh.close();
  }
}

async function handleListFiles(query) {
  const s = requireSession(query.sessionId);
  const { abs, presented, root } = resolveReadablePath(query.path ?? WORKSPACE, s.sessionId);
  const realRoot = await fs.realpath(root);
  const dfh = await fs.open(abs, FS.O_RDONLY | FS.O_DIRECTORY);
  try {
    const opened = await fs.realpath(`/proc/self/fd/${dfh.fd}`);
    if (opened !== realRoot && !opened.startsWith(`${realRoot}${path.sep}`)) {
      throw httpErr(400, `path escapes ${WORKSPACE}`);
    }
    const dir = await fs.opendir(`/proc/self/fd/${dfh.fd}`); // reads the pinned inode, not a re-walked path
    const entries = [];
    let truncated = false;
    for await (const e of dir) {
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; break; } // for-await closes the dir on break
      entries.push({ name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other" });
    }
    return { path: presented, entries, truncated };
  } finally {
    await dfh.close();
  }
}

async function handlePackage(sessionId) {
  const s = requireSession(sessionId);
  const { name: userName } = SANDBOX_USER;
  const sdir = sessionDir(s.sessionId);
  // gosu drops to the sandbox uid so .deploy-dist stays slot-owned (root-owned would EACCES later run_commands).
  const childEnv = buildChildEnv({ WDL_PACK_CWD: sdir }, process.env, sdir);
  return await new Promise((resolve, reject) => {
    // detached → child leads its own process group so a timeout SIGKILLs the whole group; else a
    // backgrounded build/wrangler grandchild holds stdout open, 'close' never fires, and the session
    // write lock stays wedged past PACK_TIMEOUT_MS. Mirrors handleRun.
    const child = spawn(
      "gosu",
      [userName, "env", `HOME=${sdir}`, "node", "/opt/sandbox-agent/scripts/pack.js"],
      { cwd: sdir, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const outSink = makeCappedSink(MAX_OUTPUT);
    const errSink = makeCappedSink(MAX_OUTPUT);
    child.stdout.on("data", outSink.onData);
    child.stderr.on("data", errSink.onData);
    let timedOut = false, settled = false, graceTimer = null;
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, PACK_TIMEOUT_MS);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      fn();
    };
    const finalize = (code, signal) => finish(() => {
      if (timedOut || signal === "SIGKILL" || signal === "SIGTERM") {
        reject(httpErr(504, `pack timed out after ${PACK_TIMEOUT_MS}ms`, {
          stderr: errSink.value.slice(0, 4000), stderrTruncated: errSink.truncated,
        }));
        return;
      }
      if (code !== 0) {
        reject(httpErr(502, `pack failed (exit ${code})`, {
          stderr: errSink.value.slice(0, 4000), stderrTruncated: errSink.truncated,
        }));
        return;
      }
      if (outSink.truncated) {
        reject(httpErr(413, `package too large: the pack manifest exceeds ${MAX_OUTPUT} bytes — reduce bundle/asset size`));
        return;
      }
      try { resolve(JSON.parse(outSink.value)); }
      catch (err) { reject(httpErr(502, `pack stdout not JSON: ${err.message}`, {
        stdout: outSink.value.slice(0, 1000),
      })); }
    });
    child.on("error", err => finish(() => reject(httpErr(500, `pack spawn failed: ${err.message}`))));
    child.on("close", (code, signal) => finalize(code, signal));
    // 'close' waits for ALL stdio; an escaped descendant can hold the pipe open — force-finalize
    // shortly after the child itself exits.
    child.on("exit", (code, signal) => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => {
        try { child.stdout.destroy(); } catch { /* ignore */ }
        try { child.stderr.destroy(); } catch { /* ignore */ }
        finalize(code, signal);
      }, 2000);
    });
  });
}

function handleHealth() {
  return { ok: true, session: session?.sessionId ?? null };
}

// Gzipped-tar download of the session tree; writes its own response so handle() branches it.
// tar archives symlinks as links, so an AI-planted symlink can't exfiltrate outside the workspace.
const EXPORT_MAX_BYTES = 100 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 60_000;

async function handleExport(query, res) {
  const s = requireSession(query.sessionId);
  const sdir = sessionDir(s.sessionId);
  // realpath-confine the project root before `tar -C` chdirs into it; a not-yet-created dir → nothing to export.
  let real;
  try { real = await realWithin(sdir, WORKSPACE); }
  catch { real = null; }
  if (!real) { sendJson(res, 404, { error: "nothing to export yet" }); return; }

  // Spool to a temp file (not RAM) so a large workspace can't OOM PID 1, while still learning
  // tar's exit code before sending a status (can't retract a status mid-body).
  // Private root-owned (0700) temp dir so the sandbox uid can't pre-plant a symlink at a predictable
  // export path; 'wx' below also refuses to follow / clobber a pre-existing file.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wdl-export-"));
  const tmp = path.join(tmpDir, "export.tgz");
  const rm = () => { fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); };
  await new Promise((resolve) => {
    const args = ["-czf", "-", "-C", real, ...EXPORT_EXCLUDES.map(e => `--exclude=${e}`), "."];
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = createWriteStream(tmp, { flags: "wx" });
    let total = 0, overflow = false, timedOut = false, stderr = "", settled = false;
    const exportTimer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* already gone */ } }, EXPORT_TIMEOUT_MS);
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(exportTimer); fn(); resolve(); };
    out.on("error", err => { try { child.kill("SIGKILL"); } catch { /* already gone */ } rm(); finish(() => sendJson(res, 500, { error: `export write failed (${err?.code ?? "EIO"})` })); });
    child.stdout.on("data", c => {
      total += c.length;
      if (total > EXPORT_MAX_BYTES && !overflow) { overflow = true; child.kill("SIGKILL"); }
    });
    child.stdout.on("error", err => { try { child.kill("SIGKILL"); } catch { /* already gone */ } out.destroy(); rm(); finish(() => sendJson(res, 500, { error: `export read failed (${err?.code ?? "EIO"})` })); });
    child.stdout.pipe(out);
    child.stderr.on("data", c => { stderr = appendCapped(stderr, c.toString("utf8"), 8192).value; });
    child.on("error", err => { out.destroy(); rm(); finish(() => sendJson(res, 500, { error: `export spawn failed: ${err.message}` })); });
    child.on("close", code => {
      out.end(() => {
        if (timedOut) { rm(); return finish(() => sendJson(res, 504, { error: `export timed out after ${EXPORT_TIMEOUT_MS}ms` })); }
        if (overflow) { rm(); return finish(() => sendJson(res, 413, { error: `export too large (> ${EXPORT_MAX_BYTES} bytes)` })); }
        if (code !== 0) {
          console.warn(`export tar exit ${code}: ${stderr.slice(0, 500)}`);
          rm();
          return finish(() => sendJson(res, 502, { error: `export failed (exit ${code})` }));
        }
        finish(() => {
          res.writeHead(200, {
            "content-type": "application/gzip",
            "content-length": total,
            "content-disposition": `attachment; filename="${exportFilename(s.ns)}"`,
          });
          const rs = createReadStream(tmp);
          rs.on("error", () => { res.destroy(); rm(); });
          rs.on("close", rm);
          rs.pipe(res);
        });
      });
    });
  });
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw httpErr(413, "body too large");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw httpErr(400, "invalid JSON body"); }
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

async function dispatch(req, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case "GET /health": return handleHealth();
    case "POST /init": return await handleInit(await readJson(req));
    case "POST /run": {
      const body = await readJson(req);
      return sessionLock.write(requireSession(body?.sessionId).sessionId, () => handleRun(body));
    }
    case "POST /write-file": {
      const body = await readJson(req);
      return sessionLock.write(requireSession(body?.sessionId).sessionId, () => handleWriteFile(body));
    }
    case "GET /read-file": {
      const q = Object.fromEntries(url.searchParams);
      return sessionLock.read(requireSession(q.sessionId).sessionId, () => handleReadFile(q));
    }
    case "GET /list-files": {
      const q = Object.fromEntries(url.searchParams);
      return sessionLock.read(requireSession(q.sessionId).sessionId, () => handleListFiles(q));
    }
    case "POST /package": {
      const body = await readJson(req);
      return coalescedPackage(requireSession(body?.sessionId).sessionId);
    }
    default: throw httpErr(404, "not found");
  }
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/export") {
      const q = Object.fromEntries(url.searchParams);
      const sid = requireSession(q.sessionId).sessionId;
      await sessionLock.read(sid, () => handleExport(q, res));
      return;
    }
    const body = await dispatch(req, url);
    sendJson(res, 200, body);
  } catch (err) {
    const status = err?.status ?? 500;
    const message = err?.message ?? "internal error";
    const body = (err?.details && typeof err.details === "object") ? { ...err.details, error: message } : { error: message };
    sendJson(res, status, body);
  }
}

async function verifySandboxUser() {
  const result = await spawnAndCollect(["id", SANDBOX_USER.name], { timeoutMs: 2000 });
  if (result.exitCode !== 0) {
    throw new Error(`sandbox user ${SANDBOX_USER.name} missing from image; stderr=${(result.stderr || "").slice(0, 200)}`);
  }
}

async function main() {
  await verifySandboxUser();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => sendJson(res, 500, { error: err?.message ?? "internal error" }));
  });
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`sandbox-agent listening on :${PORT}`);

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch(err => {
    console.error("sandbox-agent boot failed:", err);
    process.exit(1);
  });
}

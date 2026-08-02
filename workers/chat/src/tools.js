import SANDBOX_AGENTS_MD_ZH from "./agents-md.gen.js";
import SANDBOX_AGENTS_MD_EN from "./agents-md.en.gen.js";
import { errMessage, parseJson } from "./lib.js";
import { makeSseSplitter } from "./llm-sse.js";

function sandboxAgentsMd(lang) {
  return lang === "zh" ? SANDBOX_AGENTS_MD_ZH : SANDBOX_AGENTS_MD_EN;
}

const TAIL_DEFAULT_DURATION_SEC = 10;
const TAIL_MAX_DURATION_SEC = 60;
const TAIL_DEFAULT_MAX_EVENTS = 200;
const TAIL_DEFAULT_MAX_BYTES = 200_000;
const CALL_AGENT_TIMEOUT_MS = 90_000; // wall-clock per agent call (> agent-side run 45s / pack 60s caps)
const TAIL_OPEN_TIMEOUT_MS = 10_000;

function clampInt(n, min, max, def) {
  if (typeof n !== "number" || !Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function agentAuthHeader(ctx) {
  return { "X-aws-proxy-auth": ctx.authToken };
}

function agentHeaders(ctx) {
  return { "content-type": "application/json", ...agentAuthHeader(ctx) };
}

// Call the session's MicroVM agent over its public HTTPS endpoint.
async function callAgent(ctx, path, init, fetcher) {
  if (!ctx.endpoint || !ctx.authToken) {
    return { ok: false, status: 503, data: { error: "sandbox not ready" } };
  }
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(CALL_AGENT_TIMEOUT_MS)])
    : AbortSignal.timeout(CALL_AGENT_TIMEOUT_MS);
  const res = await fetcher(`https://${ctx.endpoint}${path}`, { ...init, signal });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function readFile(ctx, input, signal, fetcher) {
  if (typeof input?.path !== "string") return { error: "path required" };
  const { ok, status, data } = await callAgent(ctx,
    `/read-file?sessionId=${encodeURIComponent(ctx.sessionId)}&path=${encodeURIComponent(input.path)}`,
    { headers: agentAuthHeader(ctx), signal }, fetcher);
  return ok ? data : { error: data?.error ?? `read-file http ${status}`, status };
}

async function writeFile(ctx, input, signal, fetcher) {
  if (typeof input?.path !== "string") return { error: "path required" };
  if (typeof input?.content !== "string") return { error: "content required" };
  const body = { sessionId: ctx.sessionId, path: input.path, content: input.content };
  if (input?.encoding === "base64") body.encoding = "base64";
  const { ok, status, data } = await callAgent(ctx, "/write-file", {
    method: "POST",
    headers: agentHeaders(ctx),
    body: JSON.stringify(body),
    signal,
  }, fetcher);
  return ok ? data : { error: data?.error ?? `write-file http ${status}`, status };
}

// `name` must be pre-sanitized by the caller to a bare, traversal-free name.
export async function uploadAsset(ctx, name, contentBase64, signal, fetcher = fetch) {
  return await writeFile(
    ctx, { path: `assets/${name}`, content: contentBase64, encoding: "base64" }, signal, fetcher,
  );
}

async function listFiles(ctx, input, signal, fetcher) {
  const path = input?.path ?? "/workspace";
  const { ok, status, data } = await callAgent(ctx,
    `/list-files?sessionId=${encodeURIComponent(ctx.sessionId)}&path=${encodeURIComponent(path)}`,
    { headers: agentAuthHeader(ctx), signal }, fetcher);
  return ok ? data : { error: data?.error ?? `list-files http ${status}`, status };
}

const RUN_COMMAND_TIMEOUT_CAP_SEC = 45;

// -c in any combined short-flag run (-lc, -cl) takes the next positional as cmd.
const C_FLAG_RE = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const VALUE_TAKING_SHORT = new Set(["-o", "+o", "-D", "-I"]);
const VALUE_TAKING_LONG = new Set(["--rcfile", "--init-file"]);
const VALUE_TAKING_NPX = new Set(["-p", "--package", "-c", "--call"]);

// Quote- and heredoc-aware split on top-level operators (; & |) and newlines.
function splitTopLevelOps(cmd) {
  const out = [];
  let buf = "";
  const pendingHeredocs = [];
  for (let i = 0; i < cmd.length;) {
    const ch = cmd[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      buf += ch;
      i++;
      while (i < cmd.length && cmd[i] !== q) {
        // Backslash escapes only inside double quotes (bash single quotes are literal).
        if (cmd[i] === "\\" && q === '"' && i + 1 < cmd.length) { buf += cmd[i] + cmd[i + 1]; i += 2; continue; }
        buf += cmd[i++];
      }
      if (i < cmd.length) { buf += cmd[i++]; }
      continue;
    }
    // Heredoc <<DELIM (not <<< here-string): record the delim so the body is copied verbatim, not scanned.
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<" && cmd[i - 1] !== "<") {
      buf += "<<"; i += 2;
      let stripTabs = false;
      if (cmd[i] === "-") { stripTabs = true; buf += "-"; i++; }
      while (i < cmd.length && (cmd[i] === " " || cmd[i] === "\t")) buf += cmd[i++];
      let delim = "";
      if (cmd[i] === '"' || cmd[i] === "'") {
        const q = cmd[i]; buf += cmd[i++];
        while (i < cmd.length && cmd[i] !== q) { delim += cmd[i]; buf += cmd[i++]; }
        if (i < cmd.length) buf += cmd[i++];
      } else {
        while (i < cmd.length && /[A-Za-z0-9_]/.test(cmd[i])) { delim += cmd[i]; buf += cmd[i++]; }
      }
      if (delim) pendingHeredocs.push({ delim, stripTabs });
      continue;
    }
    if (ch === "\n") {
      i++;
      if (pendingHeredocs.length > 0) {
        // Pending heredoc bodies belong to this command — copy verbatim, then split.
        while (pendingHeredocs.length > 0) {
          const { delim, stripTabs } = pendingHeredocs.shift();
          while (i < cmd.length) {
            let j = i;
            while (j < cmd.length && cmd[j] !== "\n") j++;
            const line = cmd.slice(i, j);
            const hasNl = j < cmd.length;
            buf += cmd.slice(i, hasNl ? j + 1 : j);
            i = hasNl ? j + 1 : j;
            if ((stripTabs ? line.replace(/^\t+/, "") : line) === delim) break;
            if (!hasNl) break;
          }
        }
        out.push(buf); buf = "";
        continue;
      }
      // Trailing unescaped backslash = line continuation — join, don't split.
      if (/(?:^|[^\\])(?:\\\\)*\\$/.test(buf)) { buf = buf.slice(0, -1); continue; }
      out.push(buf); buf = "";
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|") {
      while (i < cmd.length && (cmd[i] === ";" || cmd[i] === "&" || cmd[i] === "|")) i++;
      out.push(buf); buf = "";
      continue;
    }
    buf += cmd[i++];
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function tokenizeShellArgs(s) {
  const tokens = [];
  let cur = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (cur.length > 0) { tokens.push(cur); cur = ""; }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      cur += ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\" && q === '"' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i += 2; continue; }
        cur += s[i++];
      }
      if (i < s.length) { cur += s[i++]; }
      continue;
    }
    cur += s[i++];
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

// Resolve a tokenized word to the literal string bash would pass as argv.
function shellWordValue(token) {
  let out = "";
  let i = 0;
  while (i < token.length) {
    const ch = token[i];
    if (ch === "'") {
      i++;
      while (i < token.length && token[i] !== "'") out += token[i++];
      i++;
    } else if (ch === '"') {
      i++;
      while (i < token.length && token[i] !== '"') {
        if (token[i] === "\\" && i + 1 < token.length && /["`$\\]/.test(token[i + 1])) {
          out += token[i + 1]; i += 2;
        } else { out += token[i++]; }
      }
      i++;
    } else if (ch === "\\" && i + 1 < token.length) {
      out += token[i + 1]; i += 2;
    } else {
      out += token[i++];
    }
  }
  return out;
}

// Literal argv of a segment, dropping leading sudo and VAR=value env-assignments.
function segmentArgv(seg) {
  const argv = tokenizeShellArgs(seg.trim()).map(shellWordValue);
  let i = 0;
  while (i < argv.length && (argv[i] === "sudo" || /^\w+=/.test(argv[i]))) i++;
  return argv.slice(i);
}

// Inner cmd of `bash -c <body>`/`sh -lc`, or null; a non-flag token before -c is a script path → null.
function bashWrapperInner(argv) {
  if (argv[0] !== "bash" && argv[0] !== "sh") return null;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--" || !t.startsWith("-")) return null;
    if (C_FLAG_RE.test(t)) return typeof argv[i + 1] === "string" ? argv[i + 1] : null;
    if (VALUE_TAKING_SHORT.has(t) || VALUE_TAKING_LONG.has(t)) i++;
  }
  return null;
}

// Command-substitution bodies ($(...) and backticks) to scan; skips single-quoted spans.
function extractSubstitutions(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === "'") { i++; while (i < seg.length && seg[i] !== "'") i++; continue; }
    if (ch === "\\") { i++; continue; }
    // `<<`/`<<<` begins literal stdin — stop so doc bodies aren't scanned as substitutions.
    if (ch === "<" && seg[i + 1] === "<") break;
    if (ch === "$" && seg[i + 1] === "(") {
      let depth = 1, j = i + 2, body = "";
      while (j < seg.length && depth > 0) {
        if (seg[j] === "(") depth++;
        else if (seg[j] === ")") { depth--; if (depth === 0) break; }
        body += seg[j++];
      }
      out.push(body); i = j; continue;
    }
    if (ch === "`") {
      let j = i + 1, body = "";
      while (j < seg.length && seg[j] !== "`") {
        if (seg[j] === "\\") { body += seg[j + 1] ?? ""; j += 2; continue; }
        body += seg[j++];
      }
      out.push(body); i = j; continue;
    }
  }
  return out;
}

// Literal argv of every command bash would run, recursing into bash -c bodies and substitutions.
// Fail-closed sentinel: past the recursion cap, yield this (not nothing) so the command still hits a guard.
const NESTING_TOO_DEEP = ["\u0000wdl:nesting-too-deep"];

function* commandArgvs(cmd, depth = 0) {
  if (typeof cmd !== "string") return;
  if (depth > 5) { yield NESTING_TOO_DEEP; return; }
  for (const seg of splitTopLevelOps(cmd)) {
    const argv = segmentArgv(seg);
    if (argv.length > 0) {
      yield argv;
      const inner = bashWrapperInner(argv);
      if (inner != null) yield* commandArgvs(inner, depth + 1);
    }
    for (const sub of extractSubstitutions(seg)) yield* commandArgvs(sub, depth + 1);
  }
}

// Strip a leading package-runner wrapper (npx / pnpm exec / yarn dlx / bunx).
function effectiveArgv(argv) {
  if (argv[0] === "npx") {
    let i = 1;
    while (i < argv.length && argv[i].startsWith("-")) i += VALUE_TAKING_NPX.has(argv[i]) ? 2 : 1;
    return argv.slice(i);
  }
  if ((argv[0] === "pnpm" || argv[0] === "yarn") && (argv[1] === "exec" || argv[1] === "dlx")) {
    return argv.slice(2);
  }
  if (argv[0] === "bunx") return argv.slice(1);
  return argv;
}

const NPM_INSTALL_SUBCMDS = new Set(["i", "install", "add", "ci"]);
const BLOCKED_WDL_SUBCMDS = new Set(["deploy", "pack", "tail"]);

function blockedCommandError(eff) {
  if (eff[0] === NESTING_TOO_DEEP[0]) {
    return {
      error: "command nesting is too deep to analyze safely — blocked",
      hint: "Simplify the command: avoid deeply nested shells and command substitutions.",
    };
  }
  const [cmd0, ...rest] = eff;
  if ((cmd0 === "npm" || cmd0 === "yarn") && NPM_INSTALL_SUBCMDS.has(rest[0])) {
    return {
      error: "npm / yarn install are blocked in this sandbox",
      hint: "Use `pnpm install` (or `pnpm add <pkg>`) — it's the supported package manager and it's preconfigured with a fast mirror.",
    };
  }
  if (cmd0 === "wdl" && BLOCKED_WDL_SUBCMDS.has(rest[0])) {
    return {
      error: "wdl deploy / pack / tail are blocked in this sandbox",
      hint: "Use the deploy_test tool for deploys and the tail_logs tool for logs. Other wdl subcommands (d1, r2, secret, workers, init) are allowed.",
    };
  }
  if (cmd0 === "pnpm" || cmd0 === "npm" || cmd0 === "yarn") {
    const sub = rest[0] === "run" ? rest[1] : rest[0];
    if (sub === "deploy" || /^deploy:/.test(sub ?? "")) {
      return {
        error: "running the `deploy` / `deploy:prod` npm script is blocked in this sandbox",
        hint: "Use the deploy_test tool. The script just shells out to `wdl deploy` underneath, which targets the wrong control plane.",
      };
    }
  }
  return null;
}

function isCommandPrefix(t) {
  return t === "env" || t === "command" || t === "time" || t === "nice"
    || t === "npx" || t === "bunx" || t === "pnpm" || t === "yarn" || t === "exec" || t === "dlx"
    || t.includes("=") || t.startsWith("-");
}

// `wrangler deploy` allowed only as a single invocation carrying --dry-run (not --dry-run=false).
function checkWranglerDeploy(effs) {
  const deploys = [];
  for (const eff of effs) {
    for (let i = 0; i + 1 < eff.length; i++) {
      if (eff[i] !== "wrangler" || eff[i + 1] !== "deploy") continue;
      // Real invocation only: everything before wrangler must be a command prefix, not another command's args.
      if (eff.slice(0, i).every(isCommandPrefix)) deploys.push(eff.slice(i + 2));
      break;
    }
  }
  if (deploys.length === 0) return null;
  if (deploys.length > 1) {
    return "multiple `wrangler deploy` invocations are blocked — even if one of them is --dry-run";
  }
  const args = deploys[0];
  let truthy = false, falsey = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run=false" || a === "--dry-run=0") falsey = true;
    else if (a === "--dry-run=true" || a === "--dry-run=1") truthy = true;
    else if (a === "--dry-run") {
      const next = args[i + 1];
      if (next === "false" || next === "0") falsey = true; else truthy = true;
    }
  }
  if (falsey) {
    return "`wrangler deploy --dry-run=false` (or `--dry-run false`) is a real deploy in disguise — blocked";
  }
  if (!truthy) return "`wrangler deploy` without `--dry-run` is blocked";
  return null;
}

// True only if `wdl init` is an actual top-level invocation, not a substring.
function runsWdlInitCommand(cmd) {
  for (const argv of commandArgvs(cmd)) {
    const eff = effectiveArgv(argv);
    if (eff[0] === "wdl" && eff[1] === "init") return true;
  }
  return false;
}

async function runCommand(ctx, input, signal, fetcher) {
  if (typeof input?.cmd !== "string") return { error: "cmd required" };
  const effs = [...commandArgvs(input.cmd)].map(effectiveArgv);
  for (const eff of effs) {
    const blocked = blockedCommandError(eff);
    if (blocked) return blocked;
  }
  const wranglerReason = checkWranglerDeploy(effs);
  if (wranglerReason) {
    return {
      error: `wrangler deploy is blocked in this sandbox: ${wranglerReason}`,
      hint: "Use the deploy_test tool to ship. The only allowed wrangler form is a single `wrangler deploy --dry-run --outdir=.deploy-dist` (or equivalent) for local bundle debugging — no shell chaining, no --dry-run=false.",
    };
  }
  const requested = clampInt(input.timeoutSec, 1, RUN_COMMAND_TIMEOUT_CAP_SEC, RUN_COMMAND_TIMEOUT_CAP_SEC);
  const { ok, status, data } = await callAgent(ctx, "/run", {
    method: "POST",
    headers: agentHeaders(ctx),
    body: JSON.stringify({
      sessionId: ctx.sessionId,
      cmd: input.cmd,
      timeoutSec: requested,
    }),
    signal,
  }, fetcher);
  if (ok && data?.exitCode === 0 && runsWdlInitCommand(input.cmd)) {
    try {
      await writeFile(ctx, { path: "/workspace/AGENTS.md", content: sandboxAgentsMd(ctx.language) }, signal, fetcher);
    } catch { /* best effort */ }
    try {
      await stripDeployScripts(ctx, signal, fetcher);
    } catch { /* best effort */ }
  }
  return ok ? data : { error: data?.error ?? `run http ${status}`, status };
}

async function stripDeployScripts(ctx, signal, fetcher) {
  const data = await readFile(ctx, { path: "/workspace/package.json" }, signal, fetcher);
  if (typeof data?.content !== "string") return;
  const pkg = parseJson(data.content);
  if (!pkg || typeof pkg !== "object" || !pkg.scripts || typeof pkg.scripts !== "object") return;
  let mutated = false;
  for (const k of Object.keys(pkg.scripts)) {
    if (k === "deploy" || k.startsWith("deploy:")) {
      delete pkg.scripts[k];
      mutated = true;
    }
  }
  if (!mutated) return;
  await writeFile(ctx, { path: "/workspace/package.json", content: JSON.stringify(pkg, null, 2) + "\n" }, signal, fetcher);
}

const FIXED_WORKER_NAME = "app";
const CONTROL_TIMEOUT_MS = 45_000;

function buildPreviewUrl(ns, platformDomain) {
  if (!platformDomain) return null;
  return `https://${ns}.${platformDomain}/${FIXED_WORKER_NAME}/`;
}

function summarizeArtifact(artifact) {
  const modules = artifact?.modules ?? {};
  const assets = artifact?.assets ?? {};
  return {
    modulePaths: Object.keys(modules),
    assetCount: Object.keys(assets).length,
    mainModule: artifact?.mainModule ?? null,
  };
}

async function deployTest(ctx, _input, signal, fetcher) {
  if (!ctx.env.ADMIN_URL) return { error: "ADMIN_URL not configured" };

  const pkg = await callAgent(ctx, "/package", {
    method: "POST",
    headers: agentHeaders(ctx),
    body: JSON.stringify({ sessionId: ctx.sessionId }),
    signal,
  }, fetcher);
  if (!pkg.ok) {
    return { error: pkg.data?.error ?? `package http ${pkg.status}`, status: pkg.status, upstream: pkg.data?.stderr };
  }
  const artifact = pkg.data;

  const headers = { "content-type": "application/json", "x-admin-token": ctx.nsToken };
  const nsEnc = encodeURIComponent(ctx.ns);
  const nameEnc = encodeURIComponent(FIXED_WORKER_NAME);
  const ctlSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)])
    : AbortSignal.timeout(CONTROL_TIMEOUT_MS);

  const controlPost = async (pathPart, body) => {
    const res = await fetcher(`${ctx.env.ADMIN_URL}/ns/${nsEnc}/${pathPart}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ctlSignal,
    });
    const text = await res.text();
    const json = (text ? parseJson(text) : null) ?? {};
    return { ok: res.ok, status: res.status, text, json };
  };

  const dep = await controlPost(`worker/${nameEnc}/deploy`, artifact);
  if (!dep.ok) return { error: `control deploy failed (${dep.status})`, upstream: dep.text.slice(0, 4000) };
  const version = dep.json.version;
  if (!version) return { error: "control deploy returned no version" };
  // Control surfaces binding misconfigs only via warnings — forward to the model.
  const warnings = Array.isArray(dep.json.warnings) ? dep.json.warnings : [];

  const prom = await controlPost(`worker/${nameEnc}/promote`, { version });
  if (!prom.ok) return { error: `control promote failed (${prom.status})`, upstream: prom.text.slice(0, 4000) };

  const previewUrl = buildPreviewUrl(ctx.ns, prom.json.platformDomain ?? ctx.env.PLATFORM_DOMAIN);
  if (previewUrl) ctx.setPreviewUrl(previewUrl);
  return { versionId: version, previewUrl, warnings, artifactMeta: summarizeArtifact(artifact) };
}

// Waits for tail's XREAD cursor to land, then for async console events to flush.
const CALL_PREVIEW_TAIL_CONNECT_GRACE_MS = 200;
const CALL_PREVIEW_TAIL_DRAIN_MS = 1500;
const CALL_PREVIEW_TAIL_MAX_EVENTS = 50;
const CALL_PREVIEW_TAIL_MAX_BYTES = 50_000;
const CALL_PREVIEW_TIMEOUT_MS = 45_000;
const MAX_PREVIEW_BODY_BYTES = 256 * 1024;

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

// Read a response body up to `max` bytes, then stop + cancel — a large preview body must not OOM
// the shared chat-worker.
async function readBodyCapped(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) { const t = await res.text(); return { text: t.length > max ? t.slice(0, max) : t, truncated: t.length > max }; }
  const dec = new TextDecoder();
  let out = "", total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {   // strict: an exactly-max body is complete, not truncated
      out += dec.decode(value.subarray(0, max - total), { stream: true });
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    out += dec.decode(value, { stream: true });
    total += value.byteLength;
  }
  out += dec.decode();
  return { text: out, truncated };
}

async function callPreview(ctx, input, signal, fetcher, sleep) {
  const previewUrl = ctx.previewUrl();
  if (!previewUrl) return { error: "no preview URL — run deploy_test first" };
  const path = input?.path || "/";
  const trimmed = path.replace(/^\//, "");
  const base = new URL(previewUrl.endsWith("/") ? previewUrl : `${previewUrl}/`);
  const resolved = new URL(trimmed, base); // normalizes ../ etc.
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    return { error: "preview path escapes the /app/ mount" };
  }
  const url = resolved.toString();
  // Wall-clock cap so a preview worker that never finishes responding can't hang the tool step + tail.
  const previewSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(CALL_PREVIEW_TIMEOUT_MS)])
    : AbortSignal.timeout(CALL_PREVIEW_TIMEOUT_MS);
  const init = { method: input?.method || "GET", signal: previewSignal };
  if (input?.body !== undefined && input?.body !== null) {
    init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
    init.headers = { "content-type": "application/json" };
  }

  const captureLogs = input?.capture_logs !== false;
  const tailHandle = captureLogs ? await openTailCapture(ctx, signal, fetcher) : null;
  if (tailHandle) await sleep(CALL_PREVIEW_TAIL_CONNECT_GRACE_MS);

  let fetchResult;
  try {
    const res = await fetcher(url, init);
    const { text, truncated } = await readBodyCapped(res, MAX_PREVIEW_BODY_BYTES);
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep as text */ }
    fetchResult = {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body,
    };
    if (truncated) fetchResult.body_truncated = true;
  } catch (err) {
    fetchResult = { error: errMessage(err) };
  }

  if (tailHandle) {
    await sleep(CALL_PREVIEW_TAIL_DRAIN_MS);
    const captured = await tailHandle.close();
    fetchResult.logs = captured.events;
    if (captured.truncated) fetchResult.logs_truncated = captured.truncated;
    if (captured.error) fetchResult.logs_error = captured.error;
  }
  return fetchResult;
}

// Open the control tail SSE stream for worker `app`; returns { reader, ac, release } or { error }. A fetch throw propagates.
async function openTailStream(ctx, parentSignal, fetcher) {
  const url = new URL(`${ctx.env.ADMIN_URL}/ns/${encodeURIComponent(ctx.ns)}/logs/tail`);
  // Control's param is `worker` (singular, repeatable); `workers=` 400s.
  url.searchParams.append("worker", "app");
  const ac = new AbortController();
  const onParentAbort = () => ac.abort();
  parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  const release = () => parentSignal?.removeEventListener?.("abort", onParentAbort);
  // Bound only the OPEN phase, then clear the timer — it must not also abort the long-lived response
  // body (the caller's duration timer takes over once this returns).
  const openTimer = setTimeout(() => ac.abort(), TAIL_OPEN_TIMEOUT_MS);
  let res;
  try {
    res = await fetcher(url.toString(), { headers: { "x-admin-token": ctx.nsToken }, signal: ac.signal });
  } catch (err) {
    release();
    return { error: `tail open failed: ${errMessage(err)}` };
  } finally {
    clearTimeout(openTimer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    release();
    return { error: `tail http ${res.status}: ${body.slice(0, 400)}` };
  }
  const reader = res.body?.getReader?.();
  if (!reader) { release(); return { error: "tail body has no reader" }; }
  return { reader, ac, release };
}

// call_preview's synchronous tail: open now, drain in background, close() to collect events.
async function openTailCapture(ctx, parentSignal, fetcher) {
  let opened;
  try { opened = await openTailStream(ctx, parentSignal, fetcher); }
  catch (err) { return { close: async () => ({ events: [], error: `tail open threw: ${errMessage(err)}` }) }; }
  if (opened.error) return { close: async () => ({ events: [], error: opened.error }) };
  const { reader, ac, release } = opened;
  const readerDone = drainTailSse(reader, {
    maxEvents: CALL_PREVIEW_TAIL_MAX_EVENTS,
    maxBytes: CALL_PREVIEW_TAIL_MAX_BYTES,
  });
  return {
    close: async () => {
      ac.abort();
      let result;
      try { result = await readerDone; } catch { result = { events: [], truncated: null }; }
      release();
      // Surface a genuine midstream stream error, but not the AbortError that our own ac.abort() raises.
      const midstreamError = result.readError && result.readError.name !== "AbortError"
        ? errMessage(result.readError) : null;
      const out = { events: result.events };
      if (result.truncated) out.truncated = result.truncated;
      if (midstreamError) out.error = midstreamError;
      return out;
    },
  };
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  let data = dataLines.join("\n");
  try { data = JSON.parse(data); } catch { /* leave as string */ }
  return { event, data };
}

// Shared SSE read-loop; stops at maxEvents or maxBytes.
async function drainTailSse(reader, { maxEvents, maxBytes }) {
  const events = [];
  let bytes = 0;
  let truncated = null;
  let readError = null;
  const decoder = new TextDecoder();
  const splitter = makeSseSplitter();
  const take = (blocks) => {
    for (const block of blocks) {
      if (block.trim().length === 0) continue;
      events.push(parseSseBlock(block));
      if (events.length >= maxEvents) { truncated = "maxEvents"; return true; }
    }
    return false;
  };
  while (true) {
    let chunk;
    try { chunk = await reader.read(); } catch (err) { readError = err; break; }
    if (chunk.done) { take(splitter.flush()); break; }
    const piece = decoder.decode(chunk.value, { stream: true });
    bytes += piece.length;
    if (take(splitter.push(piece))) break;
    if (bytes >= maxBytes) { truncated = "maxBytes"; break; }
  }
  return { events, bytes, truncated, readError };
}

async function tailLogs(ctx, input, signal, fetcher) {
  const durationSec = clampInt(input?.durationSec, 1, TAIL_MAX_DURATION_SEC, TAIL_DEFAULT_DURATION_SEC);
  const maxEvents = clampInt(input?.maxEvents, 1, TAIL_DEFAULT_MAX_EVENTS, TAIL_DEFAULT_MAX_EVENTS);
  const maxBytes = clampInt(input?.maxBytes, 1, TAIL_DEFAULT_MAX_BYTES, TAIL_DEFAULT_MAX_BYTES);

  let events = [];
  let bytes = 0;
  let truncated = null;
  let readError = null;
  let networkError = null;
  let ac = null, release = null, timer = null;

  try {
    const opened = await openTailStream(ctx, signal, fetcher);
    if (opened.error) return { events, bytes, truncated, error: opened.error };
    ({ ac, release } = opened);
    timer = setTimeout(() => ac.abort(), durationSec * 1000);
    ({ events, bytes, truncated, readError } = await drainTailSse(opened.reader, { maxEvents, maxBytes }));
  } catch (err) {
    if (signal?.aborted) throw err;
    if (!ac?.signal.aborted) networkError = errMessage(err);
  } finally {
    if (timer) clearTimeout(timer);
    // drainTailSse returns at maxEvents/maxBytes WITHOUT aborting — abort here so the control tail
    // stream is always closed. Resolve "duration" first, before our own abort flips the flag.
    if (truncated === null && ac?.signal.aborted && !signal?.aborted) truncated = "duration";
    ac?.abort();
    release?.();
  }

  // A midstream read error (not an abort, cap, or natural end) is a real failure — surface it so the
  // caller can tell a broken tail stream from cleanly-ended logs.
  if (!networkError && readError && truncated === null && !signal?.aborted) {
    networkError = errMessage(readError);
  }
  return { events, bytes, truncated, error: networkError };
}

const REGISTRY = {
  read_file:    readFile,
  write_file:   writeFile,
  list_files:   listFiles,
  run_command:  runCommand,
  deploy_test:  deployTest,
  call_preview: callPreview,
  tail_logs:    tailLogs,
};

export async function dispatchTool({ name, input, ctx, signal, fetcher = fetch, sleep = realSleep }) {
  const handler = REGISTRY[name];
  if (!handler) return { error: `unknown tool: ${name}` };
  return await handler(ctx, input, signal, fetcher, sleep);
}

export const __test__ = { parseSseBlock, drainTailSse, clampInt, runsWdlInitCommand };

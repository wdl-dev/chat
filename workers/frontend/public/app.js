const $ = sel => document.querySelector(sel);
const portalEl = $("#portal");
const portalForm = $("#portal-form");
const portalPasscodeEl = $("#portal-passcode");
const portalSubmitBtn = $("#portal-submit");
const portalErrorEl = $("#portal-error");
const chatHeader = $("#chat-header");
const chatMain = $("#chat-main");
const chatFooter = $("#chat-footer");
const messagesEl = $("#messages");
const previewBlock = $("#preview-block");
const previewIframe = $("#preview-iframe");
const previewLink = $("#preview-link");
const previewVersion = $("#preview-version");
const previewExpandBtn = $("#preview-expand");
const sessionIdEl = $("#session-id");
const statusEl = $("#status");
const countdownEl = $("#countdown");
const inputEl = $("#input");
const sendBtn = $("#btn-send");
const stopBtn = $("#btn-stop");
const closeBtn = $("#btn-close");
const exportBtn = $("#btn-export");
const attachBtn = $("#btn-attach");
const fileInput = $("#file-input");
const uploadChips = $("#upload-chips");
const portalLangEl = $("#portal-lang");

const STORAGE_KEY = "wdl-chat-session-id";
const EXPIRES_KEY = "wdl-chat-session-expires";
const LANG_KEY = "wdl-chat-lang";
const LANG_PREF_KEY = "wdl-chat-lang-pref";

const STRINGS = {
  en: {
    "portal.eyebrow": "self-hosted workers platform",
    "portal.sub": "Describe it in one line — the AI writes, deploys, and previews a Worker in your namespace. Enter the passcode to start a one-off session.",
    "portal.passcode": "Passcode",
    "portal.start": "Start →",
    "portal.starting": "Starting…",
    "portal.foot": "chat.wdl.dev · sessions are isolated and unrecoverable once closed",
    "portal.errDefault": "Failed to start",
    "portal.errPasscode": "passcode incorrect",
    "portal.errBusy": "All sandboxes are busy, try again later.",
    "portal.expired": "Your previous session reached the 6-hour limit and has ended.",
    "countdown.tooltip": "Sessions end 6 hours after start — export your code before the timer runs out.",
    "session.starting": "Starting…",
    "btn.stop": "Stop",
    "btn.close": "End",
    "btn.send": "Send",
    "btn.export": "Export",
    "attach.title": "Attach materials",
    "attach.aria": "Attach materials",
    "status.exporting": "Preparing export…",
    "status.exported": "Export downloaded",
    "status.uploading": "Uploading…",
    "status.uploaded": (n) => `Uploaded ${n} file${n === 1 ? "" : "s"} to ./assets`,
    "err.exportFailed": (s) => `Export failed: ${s}`,
    "err.uploadFailed": (s) => `Upload failed: ${s}`,
    "preview.title": "Preview",
    "preview.expandTitle": "Enlarge / collapse",
    "preview.expandAria": "Enlarge or collapse the preview",
    "preview.openNew": "Open in new window",
    "preview.frameTitle": "Preview",
    "preview.version": (v) => `Version ${v}`,
    "input.placeholder": "Describe the Worker to build…  (⌘ / Ctrl + Enter to send)",
    "status.connecting": "Connecting…",
    "status.ready": "Ready",
    "status.disconnected": "Disconnected — refresh to reconnect",
    "status.closed": "Session ended",
    "status.expired": "Session expired — start a new one",
    "status.closeFailed": "Couldn't end the session — try again.",
    "status.historyReplayed": (n) => `Replayed ${n} message${n === 1 ? "" : "s"}`,
    "status.drafting": "Drafting",
    "status.running": "Running",
    "status.idle": "Idle",
    "status.doneWith": (sr) => `Done (${sr})`,
    "status.failed": (e) => `Failed: ${e}`,
    "status.stopping": "Stopping the current AI run… shell commands already started may keep running until they time out.",
    "run.done": "Done",
    "run.doneWith": (sr) => `Done (${sr})`,
    "run.aborted": "Aborted",
    "run.abortedWith": (r) => `Aborted (${r})`,
    "run.failed": (e) => `Failed · ${e}`,
    "run.took": (d) => ` · ${d}`,
    "err.unknown": "unknown",
    "err.cancelFailed": (s) => `Cancel failed: ${s}`,
    "err.sendFailed": (s) => `Send failed: ${s}`,
    "err.initFailed": (m) => `Init failed: ${m}`,
    "tool.read_file": "read", "tool.write_file": "write", "tool.list_files": "list",
    "tool.run_command": "run", "tool.deploy_test": "deploy", "tool.call_preview": "preview", "tool.tail_logs": "logs", "tool.web_search": "search", "tool.web_fetch": "fetch",
    "ui.thinking": "Thinking",
    "ui.thinkingLive": (s) => `Thinking ${s}s`,
    "plan.headerRevised": "Plan (revised) — please confirm again",
    "plan.header": "Plan — please confirm",
    "plan.notePlaceholder": "Adjust the plan, or answer its questions… (≤ 5000 chars)",
    "plan.approve": "Confirm",
    "plan.revise": "Revise",
    "plan.reject": "Cancel",
    "plan.submitRevision": "Submit revision",
    "plan.errFailed": (s) => `Plan decision failed: ${s}`,
    "plan.errNetwork": "Plan decision network error",
    "dialog.closeConfirm": "End the session? The sandbox is released immediately and the session becomes unrecoverable. The temporary namespace token and any published preview aren't revoked instantly — they expire on their own within a few hours.",
  },
  zh: {
    "portal.eyebrow": "自托管 Workers 平台",
    "portal.sub": "用一句话描述，AI 在你的命名空间里写好 Worker、部署、给你预览。输入通关密语开始一个一次性会话。",
    "portal.passcode": "通关密语",
    "portal.start": "开始 →",
    "portal.starting": "开始中…",
    "portal.foot": "chat.wdl.dev · 会话独立，关闭后无法找回",
    "portal.errDefault": "开始失败",
    "portal.errPasscode": "通关密语错误",
    "portal.errBusy": "Sandbox 都在用，稍后再试。",
    "portal.expired": "上一个会话已达 6 小时上限，已结束。",
    "countdown.tooltip": "会话自开始起 6 小时后结束，请在此之前导出代码。",
    "session.starting": "启动中…",
    "btn.stop": "停止",
    "btn.close": "终止",
    "btn.send": "发送",
    "btn.export": "导出",
    "attach.title": "上传素材",
    "attach.aria": "上传素材",
    "status.exporting": "正在准备导出…",
    "status.exported": "已下载导出包",
    "status.uploading": "上传中…",
    "status.uploaded": (n) => `已上传 ${n} 个文件到 ./assets`,
    "err.exportFailed": (s) => `导出失败：${s}`,
    "err.uploadFailed": (s) => `上传失败：${s}`,
    "preview.title": "预览",
    "preview.expandTitle": "放大 / 收起",
    "preview.expandAria": "放大或收起预览",
    "preview.openNew": "新窗口打开",
    "preview.frameTitle": "预览",
    "preview.version": (v) => `版本 ${v}`,
    "input.placeholder": "描述要构建的 Worker…  (⌘ / Ctrl + Enter 发送)",
    "status.connecting": "连接中…",
    "status.ready": "就绪",
    "status.disconnected": "连接已断开，刷新页面恢复",
    "status.closed": "会话已终止",
    "status.expired": "会话已过期，请新建会话",
    "status.closeFailed": "结束会话失败，请重试。",
    "status.historyReplayed": (n) => `已重放 ${n} 条历史`,
    "status.drafting": "起草中",
    "status.running": "运行中",
    "status.idle": "空闲",
    "status.doneWith": (sr) => `已完成（${sr}）`,
    "status.failed": (e) => `失败：${e}`,
    "status.stopping": "正在停止当前 AI 运行…已启动的 shell 命令可能仍会跑到超时为止。",
    "run.done": "已完成",
    "run.doneWith": (sr) => `已完成（${sr}）`,
    "run.aborted": "已终止",
    "run.abortedWith": (r) => `已终止（${r}）`,
    "run.failed": (e) => `失败 · ${e}`,
    "run.took": (d) => ` · 用时 ${d}`,
    "err.unknown": "未知",
    "err.cancelFailed": (s) => `取消失败：${s}`,
    "err.sendFailed": (s) => `发送失败：${s}`,
    "err.initFailed": (m) => `初始化失败：${m}`,
    "tool.read_file": "读取", "tool.write_file": "写入", "tool.list_files": "列目录",
    "tool.run_command": "执行", "tool.deploy_test": "部署", "tool.call_preview": "预览", "tool.tail_logs": "日志", "tool.web_search": "搜索", "tool.web_fetch": "抓取",
    "ui.thinking": "思考",
    "ui.thinkingLive": (s) => `思考中 ${s}s`,
    "plan.headerRevised": "Plan（已修订）— 请再次确认",
    "plan.header": "Plan — 请确认",
    "plan.notePlaceholder": "调整 plan，或回答 plan 里的提问…（5000 字以内）",
    "plan.approve": "确认",
    "plan.revise": "修改",
    "plan.reject": "取消",
    "plan.submitRevision": "提交修改",
    "plan.errFailed": (s) => `plan 决策失败：${s}`,
    "plan.errNetwork": "plan 决策网络错误",
    "dialog.closeConfirm": "终止会话？Sandbox 立即释放、会话无法找回。临时命名空间令牌和已发布的预览不会被立即撤销，会在数小时内自行过期。",
  },
};

function normLang(v) { return v === "zh" ? "zh" : "en"; }

function initialLang() {
  try {
    const m = location.hash.match(/lang=([^&]+)/);
    if (m) return normLang(decodeURIComponent(m[1]));
  } catch { /* ignore */ }
  const hasSession = /session=/.test(location.hash) || localStorage.getItem(STORAGE_KEY);
  return normLang(localStorage.getItem(hasSession ? LANG_KEY : LANG_PREF_KEY));
}

let lang = initialLang();

function tr(key, ...args) {
  const pack = STRINGS[lang] || STRINGS.en;
  let v = pack[key];
  if (v === undefined) v = STRINGS.en[key];
  if (typeof v === "function") return v(...args);
  return v !== undefined ? v : key;
}

function applyI18n() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = tr(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-ph]")) el.placeholder = tr(el.dataset.i18nPh);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", tr(el.dataset.i18nAria));
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = tr(el.dataset.i18nTitle);
  if (portalLangEl) {
    for (const b of portalLangEl.querySelectorAll(".lang-opt")) b.classList.toggle("active", b.dataset.lang === lang);
  }
}

function setLang(next) {
  lang = normLang(next);
  localStorage.setItem(LANG_PREF_KEY, lang);
  applyI18n();
}

function adoptSessionLang(serverLang) {
  if (serverLang !== "en" && serverLang !== "zh") return;
  if (serverLang === lang) return;
  lang = serverLang;
  localStorage.setItem(LANG_KEY, lang);
  if (sessionId) history.replaceState(null, "", `#session=${sessionId}&lang=${lang}`);
  applyI18n();
}

portalLangEl?.addEventListener("click", (e) => {
  const b = e.target.closest(".lang-opt");
  if (b) setLang(b.dataset.lang);
});

const TOOL_NAMES = new Set(["read_file", "write_file", "list_files", "run_command", "deploy_test", "call_preview", "tail_logs", "web_search", "web_fetch"]);
function toolVerb(name) { return TOOL_NAMES.has(name) ? tr("tool." + name) : name; }

const planModeEnabled = (() => {
  try {
    return new URLSearchParams(location.hash.slice(1)).get("plan") === "1";
  } catch {
    return false;
  }
})();

let sessionId = null;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const apiBase = () => `/api/sessions/${encodeURIComponent(sessionId)}`;
let evtSource = null;
let lastStoppingNote = null;
// per-seq dedup: every /stream attach replays recent messages
const renderedMessageSeqs = new Set();

const SSE_EVENTS = [
  "message.user", "message.assistant", "message.assistant_streaming", "message.tool_pending", "message.thinking",
  "history.done",
  "run.scheduled", "run.done", "run.aborted", "run.failed", "run.cancelRequested",
  "preview.ready", "session.closed",
  "plan.draft",
];

function setStatus(text) { statusEl.textContent = text; }

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function scrollMsgs() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

const TIME_FMT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
function fmtTime(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? TIME_FMT.format(new Date(n)) : "";
}
function appendTime(div, ms) {
  const t = fmtTime(ms);
  if (!t) return;
  const el = document.createElement("div");
  el.className = "msg-time";
  el.textContent = t;
  div.appendChild(el);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

let currentRunStartedAt = null;
let currentRunId = null;
let everConnected = false;
let resuming = false;

// A run-terminal event from a superseded/older run must not clobber the active run's UI.
function staleRun(data) {
  return currentRunId != null && data?.runId != null && data.runId !== currentRunId;
}

function appendRunMarker(label, accent) {
  const time = fmtTime(Date.now());
  const dur = currentRunStartedAt != null
    ? tr("run.took", fmtDuration(Date.now() - currentRunStartedAt))
    : "";
  const foot = document.createElement("div");
  foot.className = `turn-foot turn-foot-${accent || "neutral"}`;
  const dot = document.createElement("span"); dot.className = "foot-dot";
  const lab = document.createElement("span"); lab.className = "foot-label"; lab.textContent = label;
  const meta = document.createElement("span"); meta.className = "foot-meta"; meta.textContent = `${time}${dur}`;
  foot.append(dot, lab, meta);
  if (currentAgentBody && currentAgentBody.isConnected) currentAgentBody.appendChild(foot);
  else messagesEl.appendChild(foot);
  closeAgentGroup();
  scrollMsgs();
  currentRunStartedAt = null;
}

function shouldRender(seq) {
  if (typeof seq !== "number") return true;
  if (renderedMessageSeqs.has(seq)) return false;
  renderedMessageSeqs.add(seq);
  return true;
}

function renderUser(seq, content, createdAt) {
  if (!shouldRender(seq)) return;
  let text = "";
  if (Array.isArray(content)) {
    text = content.filter(b => b?.type === "text").map(b => b.text).join("\n");
  } else if (typeof content === "string") {
    text = content;
  }
  if (!text) return;
  closeAgentGroup();
  const div = document.createElement("div");
  div.className = "msg msg-user";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  div.appendChild(body);
  appendTime(div, createdAt);
  messagesEl.appendChild(div);
  scrollMsgs();
}

const URL_ONLY_RE = /^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;

const MD_RENDERER_OPTS = (() => {
  if (typeof marked === "undefined") return null;
  const r = new marked.Renderer();
  r.html = () => "";
  const origLink = r.link.bind(r);
  r.link = (token) => {
    // security: never return raw token.text (unescaped source → XSS); parse inline tokens
    const safeLabel = () => r.parser?.parseInline(token.tokens) ?? escapeHtml(token?.text ?? "");
    const href = token?.href;
    if (typeof href !== "string") return safeLabel();
    const lower = href.trim().toLowerCase();
    // Untrusted model output: only external http(s)/mailto links. Anchor (#…), relative and site-internal
    // links render as plain text — a `#session=…` link could otherwise rewrite the hash and clobber the session.
    if (!/^(https?:|mailto:)/.test(lower)) return safeLabel();
    const html = origLink(token);
    if (/^https?:/i.test(lower)) {
      return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
    }
    return html;
  };
  r.codespan = ({ text }) => {
    // security: both branches must escape; token text is raw
    const safe = escapeHtml(text);
    if (URL_ONLY_RE.test(text)) {
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer"><code>${safe}</code></a>`;
    }
    return `<code>${safe}</code>`;
  };
  r.image = (token) => {
    // Render markdown images as click-through links, not auto-loading <img>: untrusted model/tool
    // output must not trigger a third-party image fetch (a beacon / exfil channel).
    const href = token?.href;
    if (typeof href !== "string" || !/^https?:/i.test(href.trim())) {
      return escapeHtml(token?.text ?? "");
    }
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(token?.text || href)}</a>`;
  };
  return { renderer: r, gfm: true, breaks: true };
})();

function renderMarkdown(text) {
  if (typeof text !== "string") return "";
  if (MD_RENDERER_OPTS && typeof marked !== "undefined") {
    try {
      return marked.parse(text, MD_RENDERER_OPTS);
    } catch {
      // marked throws on partial syntax mid-stream; fall back to escaped text
      return escapeHtml(text);
    }
  }
  return escapeHtml(text);
}

let streamingPlaceholder = null;
let streamingBlocks = new Map();
let streamingRenderQueued = false;

function ensureStreamingPlaceholder() {
  if (streamingPlaceholder) return streamingPlaceholder;
  const body = ensureAgentBody();
  const div = document.createElement("div");
  div.className = "md md-turn streaming";
  body.appendChild(div);
  streamingPlaceholder = div;
  streamingBlocks = new Map();
  streamingRenderQueued = false;
  return div;
}

function renderStreaming() {
  streamingRenderQueued = false;
  lastStreamingRenderAt = Date.now();
  if (!streamingPlaceholder) return;
  const ordered = [...streamingBlocks.entries()].sort(([a], [b]) => a - b);
  streamingPlaceholder.innerHTML = ordered.map(([, t]) => renderMarkdown(t)).join("");
  scrollMsgs();
}

// Throttle the streaming preview to ~15fps — full-markdown-per-frame is O(n^2) over a long response.
const STREAMING_RENDER_MIN_MS = 66;
let lastStreamingRenderAt = 0;
function queueStreamingRender() {
  ensureStreamingPlaceholder();
  if (streamingRenderQueued) return;
  streamingRenderQueued = true;
  const wait = Math.max(0, STREAMING_RENDER_MIN_MS - (Date.now() - lastStreamingRenderAt));
  setTimeout(renderStreaming, wait);
}

function appendStreamingDelta(blockIndex, delta) {
  settleThinkingRow();
  // must run before mutating the map: it resets streamingBlocks on first run
  ensureStreamingPlaceholder();
  streamingBlocks.set(blockIndex, (streamingBlocks.get(blockIndex) ?? "") + delta);
  queueStreamingRender();
}

let thinkingRow = null;
let thinkingTimer = null;

// Shows only that reasoning is running, plus elapsed seconds — the content renders collapsed when the
// turn commits. Without it a long reasoning stretch is indistinguishable from a hang.
function startThinkingRow(startedAt) {
  if (thinkingTimer) return;   // already live — the server rebroadcasts every few seconds
  if (!thinkingRow || !thinkingRow.isConnected) {
    thinkingRow = document.createElement("div");
    thinkingRow.className = "act-line";
    const span = document.createElement("span");
    span.className = "act-k";
    thinkingRow.appendChild(span);
    ensureAgentBody().appendChild(thinkingRow);
  }
  // Re-arm a settled row too: interleaved reasoning (thinking → text → thinking) pulses again.
  thinkingRow.classList.add("pending");
  const k = thinkingRow.firstChild;
  const started = Number.isFinite(startedAt) ? startedAt : Date.now();
  const tick = () => { k.textContent = tr("ui.thinkingLive", Math.max(0, Math.round((Date.now() - started) / 1000))); };
  tick();
  thinkingTimer = setInterval(tick, 1000);
  scrollMsgs();
}

// Reasoning is over once anything else streams; keep the row (the elapsed time is useful) but stop it
// pulsing, so only one thing on screen looks live at a time.
function settleThinkingRow() {
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  if (thinkingRow) thinkingRow.classList.remove("pending");
}

function clearThinkingRow() {
  settleThinkingRow();
  thinkingRow?.remove();
  thinkingRow = null;
}

let pendingToolsEl = null;
const pendingTools = new Map();   // blockIndex → { k, v } of a not-yet-committed tool row

function renderPendingTool(blockIndex, { name, path, bytes = 0 }) {
  settleThinkingRow();
  if (!pendingToolsEl || !pendingToolsEl.isConnected) {
    pendingToolsEl = document.createElement("div");
    ensureAgentBody().appendChild(pendingToolsEl);
  }
  let ent = pendingTools.get(blockIndex);
  if (!ent) {
    const row = document.createElement("div");
    row.className = "act-line pending";
    const k = document.createElement("span");
    k.className = "act-k";
    const v = document.createElement("span");
    v.className = "act-v";
    row.append(k, v);
    pendingToolsEl.appendChild(row);
    ent = { k, v };
    pendingTools.set(blockIndex, ent);
  }
  if (name) ent.k.textContent = toolVerb(name);
  if (path) ent.path = path;
  const size = bytes > 0 ? `${(bytes / 1024).toFixed(1)} KB` : "";
  ent.v.textContent = [ent.path, size].filter(Boolean).join(" · ") + "…";
  scrollMsgs();
}

function clearPendingTools() {
  pendingToolsEl?.remove();
  pendingToolsEl = null;
  pendingTools.clear();
}

function clearStreamingPlaceholder() {
  clearThinkingRow();
  clearPendingTools();
  if (streamingPlaceholder && streamingPlaceholder.parentElement) {
    streamingPlaceholder.parentElement.removeChild(streamingPlaceholder);
  }
  streamingPlaceholder = null;
  streamingBlocks = new Map();
  streamingRenderQueued = false;
}

let currentAgentBody = null;
function closeAgentGroup() {
  for (const t of messagesEl.querySelectorAll(".turn-agent.active")) t.classList.remove("active");
  currentAgentBody = null;
}

// One place for the run-terminal UI settle (done/aborted/failed differ only in text/label/accent).
const settledRuns = new Set();
function settleRunUi({ runId, statusText, markerLabel, accent, replay }) {
  clearStreamingPlaceholder();
  clearStoppingNote();
  removePlanCard();
  setStatus(statusText);
  stopBtn.disabled = true;
  // terminal marker at most once per run (a replayed/duplicate event must not double it).
  if (replay || (runId && settledRuns.has(runId))) { closeAgentGroup(); return; }
  if (runId) settledRuns.add(runId);
  appendRunMarker(markerLabel, accent);
}

function toolBase(p) {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || "");
}
function toolDetail(name, input) {
  const i = input || {};
  switch (name) {
    case "read_file":
    case "write_file":   return toolBase(i.path);
    case "list_files":   return i.path || "/workspace";
    case "run_command":  return truncate(String(i.cmd || ""), 100);
    case "call_preview": return `${String(i.method || "GET").toUpperCase()} ${i.path || "/"}`;
    case "web_search":   return truncate(String(i.query || ""), 80);
    case "web_fetch":    return truncate(String(i.url || ""), 80);
    case "deploy_test":
    case "tail_logs":    return "";
    default:             return truncate(JSON.stringify(i), 80);
  }
}

function ensureAgentBody() {
  if (currentAgentBody && currentAgentBody.isConnected) return currentAgentBody;
  const turn = document.createElement("div");
  turn.className = "turn-agent active";
  const av = document.createElement("div");
  av.className = "turn-avatar";
  av.innerHTML = '<svg class="logo-mark" aria-hidden="true"><use href="#wdl-mark"></use></svg>';
  const body = document.createElement("div");
  body.className = "turn-body";
  turn.append(av, body);
  messagesEl.appendChild(turn);
  currentAgentBody = body;
  return body;
}

function renderAssistant(seq, content, createdAt) {
  clearStreamingPlaceholder();
  if (!shouldRender(seq)) return;
  const blocks = Array.isArray(content) ? content : [];
  const thinking = blocks.filter(b => b?.type === "thinking" && b.thinking);
  const texts    = blocks.filter(b => b?.type === "text" && b.text);
  const tools    = blocks.filter(b => b?.type === "tool_use");
  if (!thinking.length && !texts.length && !tools.length) return;

  const body = ensureAgentBody();

  if (thinking.length) {
    const det = document.createElement("details");
    det.className = "think";
    const sum = document.createElement("summary");
    sum.textContent = tr("ui.thinking");
    det.appendChild(sum);
    for (const t of thinking) {
      const d = document.createElement("div");
      d.className = "md think-body";
      d.innerHTML = renderMarkdown(t.thinking);
      det.appendChild(d);
    }
    body.appendChild(det);
  }

  for (const t of texts) {
    const p = document.createElement("div");
    p.className = "md md-turn";
    p.innerHTML = renderMarkdown(t.text);
    body.appendChild(p);
  }

  for (const t of tools) {
    const row = document.createElement("div");
    row.className = "act-line";
    const k = document.createElement("span");
    k.className = "act-k";
    k.textContent = toolVerb(t.name);
    row.appendChild(k);
    const detail = toolDetail(t.name, t.input);
    if (detail) {
      const v = document.createElement("span");
      v.className = "act-v";
      v.textContent = detail;
      row.appendChild(v);
    }
    body.appendChild(row);
    if (t.name === "call_preview" &&
        STATE_CHANGING_METHODS.has(String(t.input?.method || "GET").toUpperCase())) {
      schedulePreviewRefresh();
    }
  }

  scrollMsgs();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// security: only return http(s) URLs so javascript:/data: can't reach the preview sink
function safeHttpUrl(u) {
  if (typeof u !== "string" || !u) return null;
  try {
    // no base: reject relative inputs instead of resolving against the page URL
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// previewUrl is identical across versions, so the cache-buster forces a reload.
function bustPreview(url, version) {
  const sep = url.includes("?") ? "&" : "?";
  previewIframe.src = `${url}${sep}_v=${encodeURIComponent(version)}`;
}

function showPreview(payload) {
  const url = safeHttpUrl(payload?.previewUrl);
  if (!url) return;
  bustPreview(url, payload.versionId || Date.now());
  previewLink.href = url;
  previewLink.textContent = tr("preview.openNew");
  previewVersion.textContent = payload.versionId ? tr("preview.version", payload.versionId) : "";
  previewBlock.style.display = "";
  document.body.classList.add("has-preview");
}

function togglePreviewExpand() {
  document.body.classList.toggle("preview-expanded");
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let previewRefreshTimer = null;

function schedulePreviewRefresh() {
  if (!previewLink.href || previewBlock.style.display === "none") return;
  if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
  previewRefreshTimer = setTimeout(() => {
    previewRefreshTimer = null;
    const url = safeHttpUrl(previewLink.href);
    if (!url) return;
    bustPreview(url, Date.now());
  }, 500);
}

function clearStoppingNote() {
  if (lastStoppingNote && lastStoppingNote.parentElement) {
    lastStoppingNote.parentElement.removeChild(lastStoppingNote);
  }
  lastStoppingNote = null;
}

function flashStoppingNote() {
  clearStoppingNote();
  const note = document.createElement("div");
  note.className = "stopping-note";
  note.textContent = tr("status.stopping");
  messagesEl.appendChild(note);
  lastStoppingNote = note;
  scrollMsgs();
}

function showPortal() {
  stopCountdown();
  portalEl.style.display = "";
  chatHeader.style.display = "none";
  chatMain.style.display = "none";
  chatFooter.style.display = "none";
}

function showChat() {
  portalEl.style.display = "none";
  chatHeader.style.display = "";
  chatMain.style.display = "";
  chatFooter.style.display = "";
}

// security: the session id is the bearer secret (localStorage + URL hash) — never shown in the header, so a screenshot / shared preview URL can't leak session control.
function claimSession(id) {
  sessionId = id;
  localStorage.setItem(STORAGE_KEY, sessionId);
  localStorage.setItem(LANG_KEY, lang);
  history.replaceState(null, "", `#session=${sessionId}&lang=${lang}`);
}

// EXPIRES_KEY describes the session in STORAGE_KEY, so the pair always clears together.
function clearStoredSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(EXPIRES_KEY);
}

// Show the public namespace in the header (never the secret session id).
function showSessionNs(ns) {
  if (!ns) return;
  sessionIdEl.textContent = ns;
  sessionIdEl.removeAttribute("data-i18n");  // else applyI18n resets the shown value
}

async function ensureSession() {
  // URL hash carries the bearer session secret
  const hash = location.hash.match(/session=([^&]+)/);
  const stored = localStorage.getItem(STORAGE_KEY);
  let fromHash = null;
  try { fromHash = hash ? decodeURIComponent(hash[1]) : null; } catch { fromHash = null; } // malformed %-encoding → ignore the hash
  // A crafted/invalid #session must not override — or wipe — a valid stored session; strip it and fall back.
  if (fromHash && !SESSION_ID_RE.test(fromHash)) {
    history.replaceState(null, "", location.pathname);
    fromHash = null;
  }
  const resumeId = fromHash || stored;
  if (!resumeId || !SESSION_ID_RE.test(resumeId)) {
    clearStoredSession(); // only a genuinely-bad/absent stored id reaches here → clear + portal
    showPortal();
    return false;
  }
  // A hash id from another session must not inherit the stored deadline.
  let deadline = Number(localStorage.getItem(EXPIRES_KEY));
  if (fromHash && fromHash !== stored) {
    localStorage.removeItem(EXPIRES_KEY);
    deadline = NaN;
  }
  resuming = true;
  claimSession(resumeId);
  setStatus(tr("status.connecting"));
  showChat();
  // A locally-past deadline may be clock skew — never wipe the bearer on it; attach and let the server
  // 404 (probeResumedSession) decide, while history.done re-syncs the countdown from the server value.
  if (!deadlinePassed(deadline)) startCountdown(deadline);
  return true;
}

async function portalStartSession(passcode, sessionLang) {
  const res = await fetch("/api/portal/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode, lang: sessionLang }),
  });
  if (res.status === 401) throw new Error(tr("portal.errPasscode"));
  if (res.status === 503) throw new Error(tr("portal.errBusy"));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

portalForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  portalErrorEl.textContent = "";
  portalSubmitBtn.disabled = true;
  portalSubmitBtn.textContent = tr("portal.starting");
  const passcode = portalPasscodeEl.value;
  try {
    const started = await portalStartSession(passcode, lang);
    claimSession(started.sessionId);
    if (started.expiresAt) localStorage.setItem(EXPIRES_KEY, String(started.expiresAt));
    startCountdown(started.expiresAt);
    showSessionNs(started.ns);
    showChat();
    attachStream();
    setStatus(tr("status.ready"));
  } catch (err) {
    portalErrorEl.textContent = err?.message ?? tr("portal.errDefault");
    portalSubmitBtn.disabled = false;
    portalSubmitBtn.textContent = tr("portal.start");
  }
});

let ws = null;
let sessionClosed = false;
let countdownTimer = null;

function deadlinePassed(deadline) {
  return Number.isFinite(deadline) && deadline > 0 && Date.now() >= deadline;
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// Hitting 0 ends the session client-side; the server only enforces lazily on the next request.
function startCountdown(expiresAt) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const deadline = Number(expiresAt);
  if (!countdownEl || !Number.isFinite(deadline) || deadline <= 0) return;
  const tick = () => {
    const left = deadline - Date.now();
    if (left <= 0) { endSessionUi("status.expired"); return; }
    countdownEl.textContent = `⏳ ${fmtCountdown(left)}`;
  };
  tick();
  if (!sessionClosed) countdownTimer = setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (countdownEl) countdownEl.textContent = "";
}

function endSessionUi(statusKey) {
  sessionClosed = true;
  // The close path broadcasts no run terminal first, so live indicators are torn down here.
  clearStreamingPlaceholder();
  stopCountdown();
  if (ws) { try { ws.close(1000, "session closed"); } catch { /* ignore */ } ws = null; }
  if (evtSource) { try { evtSource.close(); } catch { /* ignore */ } evtSource = null; }
  setStatus(tr(statusKey));
  stopBtn.disabled = true;
  sendBtn.disabled = true;
  inputEl.disabled = true;
  exportBtn.disabled = true;
  attachBtn.disabled = true;
  for (const b of messagesEl.querySelectorAll(".plan-card button")) b.disabled = true;
}

function attachStream() {
  attemptWebSocket((ok) => {
    if (!ok) attachSSE();
  });
}

function attemptWebSocket(done) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}${apiBase()}/stream`;
  const sock = new WebSocket(url);
  let settled = false;
  const settle = (ok) => { if (!settled) { settled = true; done(ok); } };
  const openTimer = setTimeout(() => {
    if (sock.readyState !== WebSocket.OPEN) {
      try { sock.close(); } catch { /* ignore */ }
      settle(false);
    }
  }, 3000);
  sock.addEventListener("open", () => {
    clearTimeout(openTimer);
    ws = sock;
    // A live WebSocket supersedes any SSE fallback still open.
    if (evtSource) { try { evtSource.close(); } catch { /* ignore */ } evtSource = null; }
    setStatus(tr("status.ready"));
    // 25s < ALB 60s idle timeout
    const pingTimer = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) {
        try { sock.send("ping"); } catch { /* ignore */ }
      }
    }, 25_000);
    sock.addEventListener("close", () => {
      clearInterval(pingTimer);
      ws = null;
      if (sessionClosed) return;
      setStatus(tr("status.connecting"));
      attachSSE();
    });
    sock.addEventListener("message", (ev) => {
      if (ev.data === "pong") return;
      let parsed;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      handleEvent(parsed.event, parsed.data);
    });
    settle(true);
  });
  sock.addEventListener("error", () => {
    clearTimeout(openTimer);
    if (sock.readyState !== WebSocket.OPEN) settle(false);
  });
}

async function probeResumedSession() {
  let status = 0;
  const ac = new AbortController();
  try {
    const res = await fetch(`${apiBase()}/stream`, { signal: ac.signal });
    status = res.status;
  } catch { /* network/abort — treat as transient */ }
  try { ac.abort(); } catch { /* ignore */ }  // don't consume the stream body
  if (status === 404) {
    const deadline = Number(localStorage.getItem(EXPIRES_KEY));
    clearStoredSession();
    history.replaceState(null, "", location.pathname);
    showPortal();
    if (deadlinePassed(deadline)) portalErrorEl.textContent = tr("portal.expired");
  } else {
    setStatus(tr("status.disconnected"));
  }
}

function attachSSE() {
  // close any prior EventSource so a flapping WS can't accumulate SSE connections.
  if (evtSource) { try { evtSource.close(); } catch { /* ignore */ } evtSource = null; }
  evtSource = new EventSource(`${apiBase()}/stream`);
  for (const t of SSE_EVENTS) {
    evtSource.addEventListener(t, evt => {
      let data;
      try { data = JSON.parse(evt.data); } catch { data = evt.data; }
      handleEvent(t, data);
    });
  }
  evtSource.onerror = () => {
    if (evtSource.readyState === EventSource.CONNECTING) { setStatus(tr("status.connecting")); return; }
    if (evtSource.readyState !== EventSource.CLOSED) return;
    // EventSource can't read the status — probe with fetch; bounce to portal only on a real 404, never a 5xx.
    if (resuming && !everConnected && !sessionClosed) {
      try { evtSource.close(); } catch { /* ignore */ }
      evtSource = null;
      probeResumedSession();
      return;
    }
    setStatus(tr("status.disconnected"));
  };
}

function handleEvent(type, data) {
  switch (type) {
    case "message.user":
      if (!data?.replay) clearStoppingNote();
      renderUser(data?.seq, data?.content, data?.createdAt);
      break;
    case "message.assistant":
      renderAssistant(data?.seq, data?.content, data?.createdAt);
      break;
    case "message.assistant_streaming":
      if (staleRun(data)) break;
      if (!data?.replay && typeof data?.delta === "string") {
        appendStreamingDelta(data.blockIndex ?? 0, data.delta);
      }
      break;
    case "message.thinking":
      if (staleRun(data)) break;
      if (!data?.replay) startThinkingRow(data?.startedAt);
      break;
    case "message.tool_pending":
      if (staleRun(data)) break;
      // Superseded by the committed turn's real rows — renderAssistant clears these first.
      if (!data?.replay) renderPendingTool(data?.blockIndex ?? 0, data ?? {});
      break;
    case "history.done":
      everConnected = true;
      adoptSessionLang(data?.lang);
      showSessionNs(data?.ns);
      if (!sessionClosed && Number.isFinite(data?.expiresAt) && data.expiresAt > 0) {
        localStorage.setItem(EXPIRES_KEY, String(data.expiresAt));  // authoritative — replaces any stale local copy
        startCountdown(data.expiresAt);
      }
      setStatus(tr("status.historyReplayed", data?.replayed ?? 0));
      break;
    case "run.scheduled": {
      const runMode = data?.mode ?? "free_form";
      currentRunId = data?.runId ?? null;
      removePlanCard();
      clearStreamingPlaceholder();  // drop a superseded run's half-streamed placeholder
      setStatus(runMode === "plan_confirmed" ? tr("status.drafting") : tr("status.running"));
      stopBtn.disabled = false;
      if (!data?.replay) currentRunStartedAt = Date.now();
      break;
    }
    case "run.done": {
      if (staleRun(data)) break;
      const sr = data?.stop_reason;
      const noteworthy = sr && sr !== "end_turn" && sr !== "stop_sequence" && sr !== "tool_use";
      settleRunUi({
        statusText: noteworthy ? tr("status.doneWith", sr) : tr("status.idle"),
        markerLabel: noteworthy ? tr("run.doneWith", sr) : tr("run.done"),
        accent: "ok", replay: data?.replay, runId: data?.runId,
      });
      break;
    }
    case "run.aborted": {
      if (staleRun(data)) break;
      const why = data?.reason ?? data?.error;
      settleRunUi({
        statusText: why ? tr("run.abortedWith", why) : tr("run.aborted"),
        markerLabel: why ? tr("run.abortedWith", why) : tr("run.aborted"),
        accent: "warn", replay: data?.replay, runId: data?.runId,
      });
      break;
    }
    case "run.failed":
      if (staleRun(data)) break;
      settleRunUi({
        statusText: tr("status.failed", truncate(String(data?.error ?? tr("err.unknown")), 200)),
        markerLabel: tr("run.failed", truncate(String(data?.error ?? tr("err.unknown")), 80)),
        accent: "danger", replay: data?.replay, runId: data?.runId,
      });
      break;
    case "run.cancelRequested":
      flashStoppingNote();
      break;
    case "plan.draft":
      // render on replay too: refresh during a plan wait must rebuild the card
      renderPlanCard(data?.runId, data?.plan, data?.kind, data?.attempt);
      break;
    case "preview.ready":
      showPreview(data);
      break;
    case "session.closed":
      endSessionUi(data?.reason === "expired" ? "status.expired" : "status.closed");
      break;
  }
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || !sessionId) return;
  const original = inputEl.value;
  inputEl.value = "";
  clearUploadChips();
  const mode = planModeEnabled ? "plan_confirmed" : "free_form";
  try {
    const res = await fetch(`${apiBase()}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, mode }),
    });
    if (!res.ok) {
      if (inputEl.value === "") inputEl.value = original;
      if (res.status === 410) { endSessionUi("status.expired"); return; }
      setStatus(tr("err.sendFailed", res.status));
    }
  } catch {
    if (inputEl.value === "") inputEl.value = original;
    setStatus(tr("err.sendFailed", "network"));
  }
}

async function exportCode() {
  if (!sessionId) return;
  exportBtn.disabled = true;
  setStatus(tr("status.exporting"));
  try {
    const res = await fetch(`${apiBase()}/export`);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* non-json body */ }
      setStatus(tr("err.exportFailed", msg));
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    const filename = m ? m[1] : `${sessionId}-workspace.tar.gz`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(tr("status.exported"));
  } catch {
    setStatus(tr("err.exportFailed", "network"));
  } finally {
    if (!sessionClosed) exportBtn.disabled = false;
  }
}

function addUploadChip(name) {
  uploadChips.hidden = false;
  const chip = document.createElement("span");
  chip.className = "upload-chip";
  chip.textContent = name;  // security: never innerHTML, name is user-supplied
  uploadChips.appendChild(chip);
}

// clear the upload chips once sent (the files persist in ./assets regardless).
function clearUploadChips() {
  uploadChips.replaceChildren();
  uploadChips.hidden = true;
}

async function uploadFiles(fileList) {
  if (!sessionId || !fileList || fileList.length === 0) return;
  const form = new FormData();
  for (const f of fileList) form.append("files", f);
  attachBtn.disabled = true;
  setStatus(tr("status.uploading"));
  try {
    const res = await fetch(`${apiBase()}/upload`, { method: "POST", body: form });
    let data = null;
    try { data = await res.json(); } catch { /* non-json body */ }
    if (res.status === 410) { endSessionUi("status.expired"); return; }
    if (!res.ok) {
      setStatus(tr("err.uploadFailed", data?.error || `HTTP ${res.status}`));
      return;
    }
    const all = Array.isArray(data?.files) ? data.files : [];
    const ok = all.filter(f => !f.error);
    for (const f of ok) addUploadChip(f.name);
    const failed = all.filter(f => f.error);
    setStatus(failed.length
      ? tr("err.uploadFailed", failed.map(f => f.name).join(", "))
      : tr("status.uploaded", ok.length));
  } catch {
    setStatus(tr("err.uploadFailed", "network"));
  } finally {
    if (!sessionClosed) attachBtn.disabled = false;
    fileInput.value = "";
  }
}

function removePlanCard() {
  for (const el of messagesEl.querySelectorAll(".plan-card")) el.remove();
}

function renderPlanCard(runId, planText, kind, attempt = 0) {
  if (!runId || !planText) return;
  const savedNote = messagesEl.querySelector(".plan-card .plan-note")?.value || "";
  removePlanCard();
  const card = document.createElement("div");
  card.className = "plan-card";
  card.dataset.runId = runId;

  const header = document.createElement("div");
  header.className = "plan-card-header";
  header.textContent = kind === "plan_revise" ? tr("plan.headerRevised") : tr("plan.header");
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "plan-card-body";
  // security: renderMarkdown sanitizes; never set innerHTML from raw LLM output
  body.innerHTML = renderMarkdown(planText);
  card.appendChild(body);

  const noteWrap = document.createElement("div");
  noteWrap.className = "plan-note-wrap";
  noteWrap.style.display = "none";
  const noteInput = document.createElement("textarea");
  noteInput.className = "plan-note";
  noteInput.placeholder = tr("plan.notePlaceholder");
  noteInput.rows = 2;
  noteInput.maxLength = 5000;
  noteWrap.appendChild(noteInput);
  card.appendChild(noteWrap);

  const actions = document.createElement("div");
  actions.className = "plan-actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "plan-btn plan-approve";
  approveBtn.textContent = tr("plan.approve");

  const reviseBtn = document.createElement("button");
  reviseBtn.className = "plan-btn plan-revise";
  reviseBtn.textContent = tr("plan.revise");

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "plan-btn plan-reject ghost";
  rejectBtn.textContent = tr("plan.reject");

  const sendDecision = async (decision, note) => {
    approveBtn.disabled = reviseBtn.disabled = rejectBtn.disabled = true;
    try {
      const res = await fetch(`${apiBase()}/approve-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, decision, note, attempt }),
      });
      if (res.status === 410) { endSessionUi("status.expired"); return; }
      if (!res.ok) {
        setStatus(tr("plan.errFailed", res.status));
        approveBtn.disabled = reviseBtn.disabled = rejectBtn.disabled = false;
        return;
      }
      card.remove();
      if (decision === "approve") setStatus(tr("status.running"));
    } catch {
      setStatus(tr("plan.errNetwork"));
      approveBtn.disabled = reviseBtn.disabled = rejectBtn.disabled = false;
    }
  };

  approveBtn.addEventListener("click", () => sendDecision("approve"));
  rejectBtn.addEventListener("click", () => sendDecision("reject"));
  reviseBtn.addEventListener("click", () => {
    if (noteWrap.style.display === "none") {
      noteWrap.style.display = "";
      reviseBtn.textContent = tr("plan.submitRevision");
      noteInput.focus();
      return;
    }
    const note = noteInput.value.trim();
    if (!note) { noteInput.focus(); return; }
    sendDecision("revise", note);
  });

  actions.appendChild(approveBtn);
  actions.appendChild(reviseBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  if (savedNote) {
    noteInput.value = savedNote;
    noteWrap.style.display = "";
    reviseBtn.textContent = tr("plan.submitRevision");
  }
  messagesEl.appendChild(card);
  scrollMsgs();
}

async function stop() {
  if (!sessionId) return;
  flashStoppingNote();
  try {
    const res = await fetch(`${apiBase()}/cancel`, { method: "POST" });
    if (res.status === 410) { endSessionUi("status.expired"); return; }
    if (!res.ok) setStatus(tr("err.cancelFailed", res.status));
  } catch {
    setStatus(tr("err.cancelFailed", "network"));
  }
}

async function close() {
  if (!sessionId) return;
  if (!confirm(tr("dialog.closeConfirm"))) return;
  // set first so the WS close handler doesn't reattach SSE
  sessionClosed = true;
  let closed = false;
  try {
    const res = await fetch(`${apiBase()}/close`, { method: "POST" });
    closed = res.ok || res.status === 404; // 404 = already gone
  } catch { closed = false; }
  if (!closed) {
    // the close didn't reach / complete server-side — keep the session so the user can retry
    sessionClosed = false;
    setStatus(tr("status.closeFailed"));
    return;
  }
  clearStoredSession();
  history.replaceState(null, "", location.pathname);
  renderedMessageSeqs.clear();
  endSessionUi("status.closed");
}

sendBtn.addEventListener("click", send);
inputEl.addEventListener("keydown", evt => {
  if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
    evt.preventDefault();
    send();
  }
});
stopBtn.addEventListener("click", stop);
closeBtn.addEventListener("click", close);
exportBtn?.addEventListener("click", exportCode);
attachBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", () => uploadFiles(fileInput.files));
previewExpandBtn?.addEventListener("click", togglePreviewExpand);

(async () => {
  applyI18n();
  try {
    const hasSession = await ensureSession();
    if (hasSession) attachStream();
  } catch (err) {
    setStatus(tr("err.initFailed", err?.message ?? tr("err.unknown")));
  }
})();

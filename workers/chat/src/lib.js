export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  // Only field surfaced to clients; raw err.message/stack never is.
  err.clientMessage = message;
  if (extra) err.extra = extra;
  return err;
}

export function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Must reject empty expected first: timingSafeStringEqual("","") is true.
export function requireSecretEqual(presented, expected, name, subject) {
  if (typeof expected !== "string" || expected.length === 0) {
    throw httpError(503, `${name} not configured`);
  }
  const given = presented ?? "";
  if (given.length === 0) throw httpError(401, `${subject} required`);
  if (!timingSafeStringEqual(given, expected)) {
    throw httpError(401, `${subject} incorrect`);
  }
}

export function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function newRunId() {
  return crypto.randomUUID();
}

const TOOL_RESULT_CAP = 256 * 1024;

// Cap a tool_result's serialized content (head+tail, elision marker) to keep it within model context.
export function capText(s, cap = TOOL_RESULT_CAP) {
  if (typeof s !== "string" || s.length <= cap) return s;
  const marker = `\n…[${s.length - cap} chars truncated]…\n`;
  const keep = Math.max(0, cap - marker.length);
  const head = Math.ceil(keep / 2);
  return s.slice(0, head) + marker + s.slice(s.length - (keep - head));
}

// Anthropic tool_result block.
export function toolResultBlock(toolUseId, output, isError) {
  const content = typeof output === "string" ? output : JSON.stringify(output);
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: capText(content),
    is_error: Boolean(isError),
  };
}

export function extractText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(b => b?.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .join("\n")
    .trim();
}

export function errMessage(err) {
  return String(err?.message || err);
}

// Stale-dispatch commit errors: a re-dispatch under a fresh claim already owns the run, so these
// are NOT run failures — don't settle failed. Markers: "run claim does not match instance state",
// "run claim lease has expired/is corrupt", "Workflow instance is not active", "ready token does
// not match instance state".
const REDISPATCH_ERROR_MARKERS = [
  "run claim",
  "does not match instance state",
  "instance is not active",
];

export function isRedispatchError(err) {
  const msg = errMessage(err);
  return REDISPATCH_ERROR_MARKERS.some(m => msg.includes(m));
}

// Reduce a user filename to a traversal-free leaf for ./assets.
export function safeUploadName(name) {
  const base = (typeof name === "string" ? name : "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "file";
}

// Suffix -N on a sanitized-name collision so a batch can't O_TRUNC-overwrite an upload.
export function uniqueUploadName(name, used) {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let n = 2;
  while (used.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

export function bytesToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const CHUNK = 0x8000; // chunk to avoid arg-spread overflow
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

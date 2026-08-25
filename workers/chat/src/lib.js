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

// For stored-JSON reads whose absence is handled, not fatal; sites needing a different fallback
// keep their own try/catch.
export function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function newRunId() {
  return crypto.randomUUID();
}

const TOOL_RESULT_CAP = 256 * 1024;

// A cut through a surrogate pair leaves a lone half that encodes to U+FFFD on the wire.
const dropTrailingLoneSurrogate = (s) => {
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdbff ? s.slice(0, -1) : s;
};
const dropLeadingLoneSurrogate = (s) => {
  const c = s.charCodeAt(0);
  return c >= 0xdc00 && c <= 0xdfff ? s.slice(1) : s;
};

// Cap a tool_result's serialized content (head+tail, elision marker) to keep it within model context.
export function capText(s, cap = TOOL_RESULT_CAP) {
  if (typeof s !== "string" || s.length <= cap) return s;
  const marker = `\n…[${s.length - cap} chars truncated]…\n`;
  const keep = Math.max(0, cap - marker.length);
  const head = Math.ceil(keep / 2);
  const headStr = dropTrailingLoneSurrogate(s.slice(0, head));
  const tailStr = dropLeadingLoneSurrogate(s.slice(s.length - (keep - head)));
  return headStr + marker + tailStr;
}

// Anthropic tool_result block. Top-level keys starting with "_" are stripped from the content the
// model sees: they are the machine-only channel (step journal + DO broadcasts — e.g. deploy_test's
// _artifactMeta, which the bench reads off preview.ready). This is the single choke point for both
// live results and journal replays, so the model-visible shape cannot diverge between the two.
export function toolResultBlock(toolUseId, output, isError) {
  const visible = output != null && typeof output === "object" && !Array.isArray(output)
    ? Object.fromEntries(Object.entries(output).filter(([k]) => !k.startsWith("_")))
    : output;
  const content = typeof visible === "string" ? visible : JSON.stringify(visible);
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

// Magic-byte sniff for vision-attachable image formats; client-supplied names/types are untrusted.
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

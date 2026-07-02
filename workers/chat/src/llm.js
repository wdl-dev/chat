const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_MODEL_LITE = "deepseek-v4-flash";
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_BUDGET_MS = 180_000;
const ANTHROPIC_VERSION = "2023-06-01";
const RETRY_DELAYS_MS = [500, 1500];

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

export function resolveLlmConfig(env) {
  return {
    model:      pickString(env?.LLM_MODEL,      DEFAULT_MODEL),
    modelLite:  pickString(env?.LLM_MODEL_LITE, DEFAULT_MODEL_LITE),
    baseUrl:    pickString(env?.LLM_BASE_URL,   DEFAULT_BASE_URL),
    maxTokens:  pickPositiveInt(env?.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    budgetMs:   pickPositiveInt(env?.LLM_BUDGET_MS,  DEFAULT_BUDGET_MS),
  };
}

export function pickModel(messages, cfg) {
  const last = messages?.[messages.length - 1];
  if (!last || last.role !== "user") return cfg.model;
  const content = last.content;
  if (typeof content === "string") return cfg.model;
  if (!Array.isArray(content)) return cfg.model;
  const hasText = content.some(b => b?.type === "text");
  return hasText ? cfg.model : cfg.modelLite;
}

function pickString(v, fallback) {
  return (typeof v === "string" && v.length > 0) ? v : fallback;
}
function pickPositiveInt(v, fallback) {
  const n = Number(v);
  return (Number.isInteger(n) && n > 0) ? n : fallback;
}

export function buildRequestBody({ system, messages, tools, maxTokens, model }) {
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system) body.system = system;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  return body;
}

export async function callLlmMessages({
  env,
  system,
  messages,
  tools,
  maxTokens,
  model: forcedModel,
  signal,
  fetcher = fetch,
  onDelta,
  maxAttempts = RETRY_DELAYS_MS.length + 1,
  sleep = defaultSleep,
}) {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY not configured");

  const cfg = resolveLlmConfig(env);
  const baseUrl = cfg.baseUrl;
  const chosenModel = forcedModel ?? pickModel(messages, cfg);
  const wantStream = typeof onDelta === "function";
  const body = buildRequestBody({
    system, messages, tools, model: chosenModel,
    maxTokens: maxTokens ?? cfg.maxTokens,
  });
  if (wantStream) body.stream = true;

  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  };
  // Bounded retry on transient failures (network/429/5xx) — safe: side-effect-free before tools run.
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetcher(`${baseUrl}/v1/messages`, init);
    } catch (err) {
      if (signal?.aborted || attempt >= maxAttempts) throw err;
      await sleep(RETRY_DELAYS_MS[attempt - 1], signal);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts && !signal?.aborted) {
      try { await res.body?.cancel?.(); } catch { /* free the connection */ }
      await sleep(RETRY_DELAYS_MS[attempt - 1], signal);
      continue;
    }
    break;
  }

  if (!res.ok) {
    await res.text().catch(() => {}); // drain the connection; don't log the body (it can echo prompt/context)
    console.warn(`LLM HTTP ${res.status}`);
    const err = new Error(`LLM HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (!wantStream) return await res.json();
  return await consumeAnthropicStream(res, onDelta);
}

// Returns the same shape as the non-streaming /v1/messages response.
async function consumeAnthropicStream(res, onDelta) {
  if (!res.body) throw new Error("LLM streaming response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const blocks = [];
  const partialJson = [];
  let stopReason = null;
  let usage = null;
  let messageMeta = null;

  const emit = (e) => { try { onDelta?.(e); } catch { /* a consumer error must not break the stream */ } };

  const flushBlock = (eventName, data) => {
    if (eventName === "message_start") {
      messageMeta = data?.message ?? null;
      if (messageMeta?.usage) usage = messageMeta.usage;
      return;
    }
    if (eventName === "content_block_start") {
      const idx = data?.index ?? 0;
      const block = { ...(data?.content_block ?? {}) };
      blocks[idx] = block;
      if (block.type === "tool_use") {
        partialJson[idx] = "";
        emit({ type: "tool_use_partial", index: idx, id: block.id, name: block.name });
      }
      return;
    }
    if (eventName === "content_block_delta") {
      const idx = data?.index ?? 0;
      const block = blocks[idx];
      const delta = data?.delta ?? {};
      if (!block) return;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = (block.text ?? "") + delta.text;
        // Emit the increment, not block.text (avoids O(n^2) over the stream).
        emit({ type: "text_delta", index: idx, text: delta.text });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = (block.thinking ?? "") + delta.thinking;
        emit({ type: "thinking_delta", index: idx, thinking: delta.thinking });
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = (block.signature ?? "") + delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        partialJson[idx] = (partialJson[idx] ?? "") + delta.partial_json;
      }
      return;
    }
    if (eventName === "content_block_stop") {
      const idx = data?.index ?? 0;
      const block = blocks[idx];
      if (!block) return;
      if (block.type === "tool_use") {
        const raw = partialJson[idx] ?? "";
        try { block.input = raw.length > 0 ? JSON.parse(raw) : {}; }
        catch { block.input = {}; }
        emit({ type: "tool_use_complete", index: idx, id: block.id, name: block.name, input: block.input });
      }
      return;
    }
    if (eventName === "message_delta") {
      if (data?.delta?.stop_reason) stopReason = data.delta.stop_reason;
      if (data?.usage) usage = { ...(usage ?? {}), ...data.usage };
      return;
    }
    if (eventName === "message_stop") {
      emit({ type: "message_complete", stop_reason: stopReason });
      return;
    }
    if (eventName === "error") {
      // Never surface OR log upstream fields — type/message are free-form and can echo prompt/context.
      throw new Error("LLM stream error");
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Normalize CRLF on the whole buffer: a \r\n can straddle a chunk boundary.
    buf = buf.replace(/\r\n/g, "\n");
    while (true) {
      const sep = buf.indexOf("\n\n");
      if (sep === -1) break;
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let eventName = null;
      let dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        // SSE: multiple data: lines in one event join with \n.
        else if (line.startsWith("data:")) dataStr += (dataStr ? "\n" : "") + line.slice(5).replace(/^ /, "");
      }
      if (!eventName) continue;
      let data = null;
      if (dataStr.length > 0) {
        try { data = JSON.parse(dataStr); } catch { data = null; }
      }
      flushBlock(eventName, data);
    }
  }

  return {
    id: messageMeta?.id ?? null,
    type: "message",
    role: messageMeta?.role ?? "assistant",
    model: messageMeta?.model ?? null,
    content: blocks.filter(b => b !== undefined),
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

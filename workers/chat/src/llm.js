import { consumeOpenAiStream, fromOpenAiResponse, toOpenAiBody } from "./llm-openai.js";
import { finalizeResponse, parseToolInput, safeEmit, salvageContent, sseFrames } from "./llm-sse.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_BASE_URL_OPENAI = "https://api.deepseek.com";
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

// The raw value is never echoed — the message reaches runs.error and the UI, and a secret pasted
// into the wrong variable would be published with it.
function pickEnum(raw, name, def, alt) {
  if (raw != null && raw !== "" && raw !== def && raw !== alt) {
    throw new Error(`invalid ${name} (expected "${def}" or "${alt}")`);
  }
  return raw === alt ? alt : def;
}

export function resolveLlmConfig(env) {
  // A typo must not fall back to Anthropic — that would send the key to the wrong provider
  // (an OpenAI key as x-api-key to the DeepSeek default URL).
  const apiShape = pickEnum(env?.LLM_API_SHAPE, "LLM_API_SHAPE", "anthropic", "openai");
  return {
    apiShape,
    model:      pickString(env?.LLM_MODEL,      DEFAULT_MODEL),
    modelLite:  pickString(env?.LLM_MODEL_LITE, DEFAULT_MODEL_LITE),
    baseUrl:    pickString(env?.LLM_BASE_URL, apiShape === "openai" ? DEFAULT_BASE_URL_OPENAI : DEFAULT_BASE_URL).replace(/\/+$/, ""),
    maxTokens:  pickPositiveInt(env?.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    budgetMs:   pickPositiveInt(env?.LLM_BUDGET_MS,  DEFAULT_BUDGET_MS),
    reasoningEffort: pickString(env?.LLM_REASONING_EFFORT, null),
    // OpenAI shape only; the default is the field DeepSeek honors, OpenAI reasoning models need the
    // override. Strict because Chat Completions silently accepts unknown cap fields (measured with
    // `max_output_tokens`) — the provider would never surface the typo and the cap would go unenforced.
    maxTokensParam: pickEnum(env?.LLM_MAX_TOKENS_PARAM, "LLM_MAX_TOKENS_PARAM", "max_tokens", "max_completion_tokens"),
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

export function buildRequestBody({ system, messages, tools, maxTokens, model, reasoningEffort }) {
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system) body.system = system;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  // Anthropic-shape effort is nested output_config.effort (top-level reasoning_effort is OpenAI's).
  if (reasoningEffort) body.output_config = { effort: reasoningEffort };
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
  // (abortReason) => boolean. True means "this abort was our own deadline, not a provider failure",
  // so a partially streamed turn is worth keeping rather than discarding.
  salvageOnAbort,
}) {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY not configured");

  const cfg = resolveLlmConfig(env);
  const baseUrl = cfg.baseUrl;
  const openai = cfg.apiShape === "openai";
  const chosenModel = forcedModel ?? pickModel(messages, cfg);
  const wantStream = typeof onDelta === "function";
  const body = (openai ? toOpenAiBody : buildRequestBody)({
    system, messages, tools, model: chosenModel,
    maxTokens: maxTokens ?? cfg.maxTokens,
    maxTokensParam: cfg.maxTokensParam,
    reasoningEffort: cfg.reasoningEffort,
  });
  if (wantStream) {
    body.stream = true;
    // Standard OpenAI streams only emit the usage frame when it is asked for; Kimi/DeepSeek volunteer it.
    if (openai) body.stream_options = { include_usage: true };
  }

  const headers = { "content-type": "application/json" };
  if (openai) {
    headers["authorization"] = `Bearer ${apiKey}`;
  } else {
    // x-api-key only: some Anthropic-shape endpoints reject an unexpected Authorization header.
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }
  const url = openai ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/messages`;
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  };
  // Bounded retry on transient failures (network/429/5xx) — safe: side-effect-free before tools run.
  // Log every retry: a 429 that later succeeds is otherwise invisible.
  const startedAt = Date.now();
  let res;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      res = await fetcher(url, init);
    } catch (err) {
      if (signal?.aborted || attempt >= maxAttempts) throw err;
      console.warn(`LLM attempt ${attempt}/${maxAttempts} failed model=${chosenModel} cause=network`);
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1), signal);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts && !signal?.aborted) {
      try { await res.body?.cancel?.(); } catch { /* free the connection */ }
      console.warn(`LLM attempt ${attempt}/${maxAttempts} failed model=${chosenModel} cause=${res.status}`);
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1), signal);
      continue;
    }
    break;
  }
  if (!res.ok) {
    await res.text().catch(() => {}); // drain the connection; don't log the body (it can echo prompt/context)
    console.warn(`LLM HTTP ${res.status} model=${chosenModel} attempts=${attempt} ${Date.now() - startedAt}ms`);
    const err = new Error(`LLM HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // Log only once the body is fully parsed: 2xx headers can still be followed by a JSON/SSE read failure.
  let parsed;
  if (wantStream) {
    try {
      parsed = await (openai ? consumeOpenAiStream(res, onDelta) : consumeAnthropicStream(res, onDelta));
    } catch (err) {
      if (!err?.partial || !salvageOnAbort?.(signal?.reason)) throw err;
      parsed = err.partial;
      parsed.salvaged = true;
      console.warn(`LLM salvaged a cut-short turn model=${chosenModel} reason=${String(signal?.reason)} ${Date.now() - startedAt}ms`);
    }
  } else {
    // A JSON.parse error's message carries the raw body — throw a fixed one so it can't leak into runs.error.
    let json;
    try { json = await res.json(); } catch { throw new Error("LLM response: malformed JSON body"); }
    // Some gateways answer HTTP 200 with an error body; both stream consumers already detect this.
    if (json?.error) throw new Error("LLM provider returned an error");
    parsed = openai ? fromOpenAiResponse(json) : json;
  }
  parsed = finalizeResponse(parsed, wantStream ? onDelta : undefined);
  if (attempt > 1) {
    console.log(`LLM ok after ${attempt} attempts model=${chosenModel} ${Date.now() - startedAt}ms`);
  }
  return parsed;
}

const HANDLED_EVENTS = new Set([
  "error", "message_start", "content_block_start", "content_block_delta", "content_block_stop",
  "message_delta", "message_stop",
]);

// Returns the same shape as the non-streaming /v1/messages response.
async function consumeAnthropicStream(res, onDelta) {
  const blocks = [];
  const partialJson = [];
  let stopReason = null;
  let usage = null;
  let messageMeta = null;
  let sawMessageStop = false;

  const emit = safeEmit(onDelta);

  const flushBlock = (eventName, data) => {
    if (eventName === "error") {
      // Never surface OR log upstream fields — type/message are free-form and can echo prompt/context.
      throw new Error("LLM stream error");
    }
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
        // The wire's content_block_start carries an `input: {}` placeholder. Drop it so
        // `input !== undefined` genuinely means "content_block_stop ran" (the salvage predicate).
        delete block.input;
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
        emit({ type: "tool_use_progress", index: idx, name: block.name, bytes: partialJson[idx].length, head: partialJson[idx].slice(0, 300) });
      }
      return;
    }
    if (eventName === "content_block_stop") {
      const idx = data?.index ?? 0;
      const block = blocks[idx];
      if (!block) return;
      if (block.type === "tool_use") {
        block.input = parseToolInput(partialJson[idx]);
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
      sawMessageStop = true;   // message_complete is emitted by finalizeResponse, once it has passed
      return;
    }
  };

  const build = (content, stop) => ({
    id: messageMeta?.id ?? null,
    type: "message",
    role: messageMeta?.role ?? "assistant",
    model: messageMeta?.model ?? null,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  });
  const present = () => blocks.filter(b => b !== undefined);

  try {
    for await (const { event, dataStr } of sseFrames(res)) {
      // Anything else (a proxy keepalive, a provider notice) carries nothing we consume, and its
      // payload is not always JSON.
      if (!HANDLED_EVENTS.has(event)) continue;
      let data = null;
      if (dataStr.length > 0) {
        // Skip, same as the OpenAI wire: one corrupted frame costs its delta, not the whole turn.
        // Except the terminator — it needs no payload, and skipping it would fail a delivered turn.
        try { data = JSON.parse(dataStr); } catch { if (event !== "message_stop") continue; }
      }
      flushBlock(event, data);
      if (sawMessageStop) break;   // final event — stop, don't wait for HTTP EOF
    }
  } catch (err) {
    throw salvaged(err);
  }
  // Either missing means the stream was cut short, and recording a partial turn as finished would
  // hand the model a truncated answer as if it were complete.
  if (!stopReason || !sawMessageStop) throw salvaged(new Error("LLM stream did not complete"));

  return build(present(), stopReason);

  function salvaged(err) {
    const part = salvageContent(present());
    if (part) err.partial = build(part.content, part.stop_reason);
    return err;
  }
}

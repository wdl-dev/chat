// OpenAI Chat Completions wire adapter. The DO pipeline speaks Anthropic content blocks
// end to end; this module converts in both directions at the provider boundary only, so
// storage, replay, and the UI never see the wire shape.

import { parseToolInput, safeEmit, salvageContent, sseFrames } from "./llm-sse.js";

const STOP_MAP = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens" };
// Own-property check so a finish_reason like "constructor" passes through, not the inherited method.
const mapStop = (r) => r == null ? null : (Object.hasOwn(STOP_MAP, r) ? STOP_MAP[r] : r);

// tool_result ids are matched by strict equality downstream, so numeric gateway ids become strings.
const toId = (id) => id == null ? undefined : String(id);

// Dispatch no longer depends on stop_reason (the run loop branches on content), but the recorded
// stop_reason still feeds replay and the UI — remap plain "stop" alongside tool_calls so the
// transcript reads what actually happened. Truncation (`length` → max_tokens) stays visible.
const stopWithTools = (finishReason, hasTools) => {
  const mapped = mapStop(finishReason);
  return (hasTools && mapped === "end_turn") ? "tool_use" : mapped;
};

function mapUsage(u) {
  if (!u) return null;
  return { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 };
}

export function toOpenAiBody({ system, messages, tools, maxTokens, maxTokensParam, model, reasoningEffort }) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages ?? []) {
    if (typeof m?.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m?.content)) continue;
    if (m.role === "assistant") {
      const texts = [];
      const thinkings = [];
      const toolCalls = [];
      for (const b of m.content) {
        if (b?.type === "text") texts.push(b.text ?? "");
        else if (b?.type === "thinking") thinkings.push(b.thinking ?? "");
        else if (b?.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            // A nameless tool_use would serialize to a function object missing its required name,
            // which the provider 400s on — for this turn and every later replay of it.
            function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      // Blocks are separate units — joining without a separator hands the model run-on sentences.
      const text = texts.join("\n");
      const thinking = thinkings.join("\n");
      const msg = { role: "assistant", content: text };
      // Providers require historical reasoning replayed.
      if (thinking) msg.reasoning_content = thinking;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      // Nothing recognized (a redacted_thinking-only turn, or a block type added later) would post an
      // empty assistant message; providers that 400 on that would do so on every later turn too,
      // since the block stays in the transcript.
      if (text || thinking || toolCalls.length > 0) out.push(msg);
    } else {
      // tool messages must precede the turn's user text.
      const texts = [];
      for (const b of m.content) {
        if (b?.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          });
        } else if (b?.type === "text") {
          texts.push(b.text ?? "");
        }
      }
      const text = texts.join("\n");
      if (text) out.push({ role: m.role, content: text });
    }
  }
  const body = { model, [maxTokensParam || "max_tokens"]: maxTokens, messages: out };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  return body;
}

export function fromOpenAiResponse(json) {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  // An empty reasoning_content carries nothing; storing it as a thinking block only creates one that
  // Anthropic-shape endpoints reject if the wire shape is ever flipped mid-session.
  if (msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }
  // content can arrive as a string or as content-parts; either way it is assistant text.
  const raw = msg.content;
  const text = typeof raw === "string" ? raw
    : Array.isArray(raw) ? raw.map((p) => typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "").join("") : "";
  if (text.length > 0) content.push({ type: "text", text });
  // The safety decline is assistant text too — its own block, so it never fuses with the answer.
  if (typeof msg.refusal === "string" && msg.refusal.length > 0) content.push({ type: "text", text: msg.refusal });
  for (const tc of msg.tool_calls ?? []) {
    content.push({ type: "tool_use", id: toId(tc?.id), name: tc?.function?.name, input: parseToolInput(tc?.function?.arguments) });
  }
  const stopReason = stopWithTools(choice.finish_reason, content.some(b => b.type === "tool_use"));
  return {
    id: json?.id ?? null,
    type: "message",
    role: "assistant",
    model: json?.model ?? null,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(json?.usage),
  };
}

// Same contract as consumeAnthropicStream: emits the shared onDelta events and returns
// the non-streaming Anthropic response shape.
export async function consumeOpenAiStream(res, onDelta) {
  const blocks = [];
  // Keyed by index AND by id — a delta may carry either, and both must resolve to the same entry.
  const toolCalls = new Map();
  // Namespaced so a numeric id can't collide with an index key.
  const idKey = (id) => `id:${id}`;
  let openToolKey = null;
  let thinkingIdx = -1;
  let textIdx = -1;
  let refusalIdx = -1;
  let stopReason = null;
  let usage = null;
  let messageId = null;
  let model = null;

  const emit = safeEmit(onDelta);

  // Salvage path: parseToolInput degrades bad JSON to {}, which would dispatch a half-streamed call
  // with no arguments. Here anything not provably closed leaves `input` unset so the block is dropped:
  // an unparseable buffer was mid-stream, and zero argument bytes means the cut landed between the
  // opening delta and the first fragment — a no-arg call that actually finished streams "{}".
  const settleToolsStrict = () => {
    for (const { idx, args } of new Set(toolCalls.values())) {
      const block = blocks[idx];
      if (args && typeof args === "object") block.input = args;
      else if (typeof args === "string" && args !== "") {
        try { block.input = JSON.parse(args); } catch { /* still streaming */ }
      }
    }
  };

  const finalizeTools = () => {
    for (const { idx, args } of new Set(toolCalls.values())) {
      const block = blocks[idx];
      block.input = parseToolInput(args);
      emit({ type: "tool_use_complete", index: idx, id: block.id, name: block.name, input: block.input });
    }
  };

  const handleChunk = (data) => {
    // Never surface upstream error fields — they are free-form and can echo prompt/context.
    if (data?.error) throw new Error("LLM stream error");
    if (data?.id && !messageId) messageId = data.id;
    if (data?.model && !model) model = data.model;
    // Usage placement varies: top level on the finish chunk (DeepSeek), a choices-empty
    // trailer (standard stream_options), or the final chunk's choices[0] (Kimi).
    if (data?.usage) usage = mapUsage(data.usage);
    const choice = data?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (delta.reasoning_content) {
      if (thinkingIdx === -1) { thinkingIdx = blocks.length; blocks.push({ type: "thinking", thinking: "" }); }
      blocks[thinkingIdx].thinking += delta.reasoning_content;
      emit({ type: "thinking_delta", index: thinkingIdx, thinking: delta.reasoning_content });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (textIdx === -1) { textIdx = blocks.length; blocks.push({ type: "text", text: "" }); }
      blocks[textIdx].text += delta.content;
      emit({ type: "text_delta", index: textIdx, text: delta.content });
    }
    // Own block, same rule as fromOpenAiResponse: the refusal never fuses with the answer.
    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      if (refusalIdx === -1) { refusalIdx = blocks.length; blocks.push({ type: "text", text: "" }); }
      blocks[refusalIdx].text += delta.refusal;
      emit({ type: "text_delta", index: refusalIdx, text: delta.refusal });
    }
    // Index, or id when a gateway omits index; a fragment carrying neither continues the call being
    // streamed (providers emit calls one at a time).
    for (const tc of delta.tool_calls ?? []) {
      const key = tc?.index ?? (tc?.id != null ? idKey(tc.id) : openToolKey);
      if (key == null) continue;
      // A delta carrying both identifiers may follow one that carried only the id; an id-less,
      // name-less fragment continues the open call even if this index was never registered.
      let entry = toolCalls.get(key) ?? (tc?.id != null ? toolCalls.get(idKey(tc.id)) : undefined);
      if (!entry && tc?.id == null && tc?.function?.name == null && openToolKey != null) {
        entry = toolCalls.get(openToolKey);
      }
      openToolKey = key;
      if (!entry) {
        entry = { idx: blocks.length, args: "" };
        toolCalls.set(key, entry);
        blocks.push({ type: "tool_use", id: toId(tc?.id), name: tc?.function?.name });
        emit({ type: "tool_use_partial", index: entry.idx, id: tc?.id, name: tc?.function?.name });
      } else {
        // id/name can trickle in after the first delta.
        const block = blocks[entry.idx];
        if (tc?.id != null && !block.id) block.id = toId(tc.id);
        if (tc?.function?.name && !block.name) block.name = tc.function.name;
      }
      // Register every identifier seen, so a later delta bearing only one still finds this entry.
      if (tc?.id != null) toolCalls.set(idKey(tc.id), entry);
      if (tc?.index != null) toolCalls.set(tc.index, entry);
      const args = tc?.function?.arguments;
      if (typeof args === "string") entry.args = (typeof entry.args === "string" ? entry.args : "") + args;
      else if (args && typeof args === "object") entry.args = args;
      if (typeof entry.args === "string") {
        emit({ type: "tool_use_progress", index: entry.idx, name: blocks[entry.idx].name, bytes: entry.args.length, head: entry.args.slice(0, 300) });
      }
    }
    // Not toolCalls.size — that Map holds both index and id keys for the same call.
    if (choice.finish_reason) stopReason = stopWithTools(choice.finish_reason, blocks.some(x => x.type === "tool_use"));
    if (choice.usage) usage = mapUsage(choice.usage);
  };

  const build = (content, stop) => ({
    id: messageId, type: "message", role: "assistant", model,
    content, stop_reason: stop, stop_sequence: null, usage,
  });
  const partial = () => {
    settleToolsStrict();
    return salvageContent(blocks);
  };

  let sawDone = false;
  try {
    for await (const { dataStr } of sseFrames(res)) {
      if (dataStr === "[DONE]") { sawDone = true; break; }
      if (!dataStr) continue;
      let data;
      // Same tolerance the Anthropic wire has: a keepalive or notice frame is not always JSON.
      try { data = JSON.parse(dataStr); } catch { continue; }
      handleChunk(data);
    }
  } catch (err) {
    const p = partial();
    if (p) err.partial = build(p.content, p.stop_reason);
    throw err;
  }
  // Every provider we use sends [DONE] last, after the finish_reason; either missing means the stream
  // was cut short, and recording a partial turn as finished hands the model a truncated answer.
  if (!stopReason || !sawDone) {
    const p = partial();
    const err = new Error("LLM stream did not complete");
    if (p) err.partial = build(p.content, p.stop_reason);
    throw err;
  }
  finalizeTools();

  return build(blocks, stopReason);
}

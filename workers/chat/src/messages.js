import { extractText, parseJson, toolResultBlock } from "./lib.js";

const MISSING_REASON = "tool dispatch did not complete";
const PRIOR_ELIDED = "[earlier tool output omitted to fit the context window]";

// Empty / whitespace-only assistant turns 400 the API.
function hasAssistantContent(content) {
  return content.some(b =>
    b?.type === "tool_use" || b?.type === "thinking" || b?.type === "redacted_thinking"
    || (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0));
}

// Orphan tool_results or unpaired tool_uses both 400 the API.
export function healMessages(rawMessages) {
  const messages = rawMessages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content) ? [...m.content] : m.content,
  }));

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    if (!m.content.some(b => b?.type === "tool_result")) continue;
    const prev = messages[i - 1];
    const validIds = new Set();
    if (prev?.role === "assistant" && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        if (b?.type === "tool_use" && typeof b.id === "string") validIds.add(b.id);
      }
    }
    m.content = m.content.filter(b =>
      b?.type !== "tool_result" || (typeof b.tool_use_id === "string" && validIds.has(b.tool_use_id)),
    );
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && Array.isArray(m.content) && m.content.length === 0) {
      messages.splice(i, 1);
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.content) && !hasAssistantContent(m.content)) {
      messages.splice(i, 1);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const toolUseIds = m.content
      .filter(b => b?.type === "tool_use" && typeof b.id === "string")
      .map(b => b.id);
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    const matched = new Set();
    if (next?.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") matched.add(b.tool_use_id);
      }
    }
    const missing = toolUseIds.filter(id => !matched.has(id));
    if (missing.length === 0) continue;
    const synth = missing.map(id =>
      toolResultBlock(id, { aborted: true, reason: MISSING_REASON }, true));
    if (next?.role === "user" && Array.isArray(next.content)) {
      next.content = [...next.content, ...synth];
    } else {
      messages.splice(i + 1, 0, { role: "user", content: synth });
    }
  }

  return messages;
}

// API 400s on non-alternating roles — merge adjacent same-role turns.
function coalesceRoles(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && Array.isArray(prev.content) && Array.isArray(m.content)) {
      const merged = [...prev.content, ...m.content];
      // Reasoning models require thinking blocks first — re-hoist when merging assistant turns.
      prev.content = m.role === "assistant" ? [...merged.filter(isThinking), ...merged.filter(b => !isThinking(b))] : merged;
    } else {
      out.push({ role: m.role, content: Array.isArray(m.content) ? [...m.content] : m.content });
    }
  }
  return out;
}

function isThinking(b) {
  return b?.type === "thinking" || b?.type === "redacted_thinking";
}

// Build the API-valid LLM window (user-first, tool pairing repaired, never empty).
export function windowLlmMessages(raw, { stripTools = false, maxMessages = null } = {}) {
  let cleaned = raw;
  // DS V4 emits DSML tool_calls from tool history even in plan stage; strip them.
  if (stripTools) {
    cleaned = cleaned
      .map(m => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.filter(b => b?.type !== "tool_use" && b?.type !== "tool_result")
          : m.content,
      }))
      .filter(m => Array.isArray(m.content) ? m.content.length > 0 : true);
  }
  // Window must start on a user role (Anthropic 400s on assistant-first).
  if (typeof maxMessages === "number" && cleaned.length > maxMessages) {
    let start = Math.max(0, cleaned.length - maxMessages);
    while (start < cleaned.length && cleaned[start].role !== "user") {
      start++;
    }
    cleaned = cleaned.slice(start);
    // Strip leading orphan tool_results; placeholder if that empties the turn (else the window 400s).
    if (cleaned.length > 0 && cleaned[0].role === "user" && Array.isArray(cleaned[0].content)) {
      const stripped = cleaned[0].content.filter(b => b?.type !== "tool_result");
      if (stripped.length !== cleaned[0].content.length) {
        cleaned = [
          { role: "user", content: stripped.length > 0 ? stripped : [{ type: "text", text: PRIOR_ELIDED }] },
          ...cleaned.slice(1),
        ];
      }
    }
  }
  // DO NOT strip `thinking` blocks — DS V4 Pro 400s if prior assistant turns omit them.
  let healed = healMessages(cleaned);
  while (healed.length > 0 && healed[0].role !== "user") {
    healed = healed.slice(1);
  }
  // Fallback if the window pruned to empty; avoids Anthropic 400 on empty messages.
  if (healed.length === 0) {
    for (let i = raw.length - 1; i >= 0; i--) {
      const m = raw[i];
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      const textOnly = m.content.filter(b => b?.type === "text");
      if (textOnly.length > 0) {
        healed = [{ role: "user", content: textOnly }];
        break;
      }
    }
  }
  return coalesceRoles(healed);
}

// The answer axis, not the visibility axis: thinking renders (collapsed) but is not an answer.
// Distinct from llm-sse's renderability check, which counts thinking because it still displays.
export function hasAnswerContent(content) {
  return (content ?? []).some(b =>
    b?.type === "tool_use" || (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== ""));
}

// Re-dispatch idempotency: replay the recorded assistant reply instead of re-calling the LLM; null = run it.
export function replayLlmTurnOutcome(lastMessage, stopReason) {
  if (!lastMessage || lastMessage.role !== "assistant") return null;
  const content = parseJson(lastMessage.content);
  const blocks = Array.isArray(content) ? content : [];
  const hasToolUses = blocks.some(b => b?.type === "tool_use");
  // Persisted stop_reason keeps replay faithful (don't replay a truncated turn as tool_use).
  const sr = (typeof stopReason === "string" && stopReason.length > 0)
    ? stopReason
    : (hasToolUses ? "tool_use" : "end_turn");
  // No hasOutput: replay stays faithful to what was recorded (a blank turn a previous version
  // recorded as success must not flip the run to failed) — the empty-turn judgement is live-only.
  return { outcome: "done", stopReason: sr, hasToolUses };
}

// Plan replay: return the recorded plan instead of re-calling the plan LLM.
export function replayPlanOutcome(lastMessage) {
  if (!lastMessage || lastMessage.role !== "assistant") return null;
  return { outcome: "done", plan: extractText(parseJson(lastMessage.content) ?? []) };
}

// Batch already ran if the last turn carries tool_results — don't re-execute (side effects).
export function toolBatchAlreadyRan(lastMessage) {
  if (!lastMessage || lastMessage.role !== "user") return false;
  const content = parseJson(lastMessage.content);
  return Array.isArray(content) && content.some(b => b?.type === "tool_result");
}

// Idempotency anchor for plan-revise/approve: a user turn carrying exactly this text.
export function isUserTextTurn(row, text) {
  if (!row || row.role !== "user") return false;
  const content = parseJson(row.content);
  return Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && content[0]?.text === text;
}

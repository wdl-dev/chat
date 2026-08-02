// SSE transport shared by both wire shapes; per-frame semantics stay in each consumer.

// Incremental frame splitter shared by every SSE consumer (both LLM wires, the control-plane tail).
// The spec allows CRLF, LF and bare-CR line terminators; all are normalized on the whole buffer
// because a \r\n can straddle a chunk boundary — a buffer-final \r is held back for the same reason.
export function makeSseSplitter() {
  let buf = "";
  return {
    push(text) {
      buf += text;
      buf = buf.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
      const frames = [];
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        frames.push(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
      return frames;
    },
    // A body that ends right after its last data line still delivered that frame; dropping it would
    // fail a turn received in full, because the consumers require their terminator.
    flush() {
      const rest = buf.replace(/\r$/, "\n");
      buf = "";
      return rest.trim() !== "" ? [rest] : [];
    },
  };
}

export async function* sseFrames(res) {
  if (!res.body) throw new Error("LLM streaming response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const splitter = makeSseSplitter();
  const parseFrame = (block) => {
    let event = null;
    let dataStr = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += (dataStr ? "\n" : "") + line.slice(5).replace(/^ /, "");
    }
    return { event, dataStr };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const block of splitter.push(decoder.decode(value, { stream: true }))) yield parseFrame(block);
    }
    for (const block of splitter.flush()) yield parseFrame(block);
  } finally {
    // Breaking out (e.g. on [DONE]) or erroring must free the connection, not wait for EOF.
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

// A turn cut short mid-stream still carries finished work. Keep the prose and any tool call whose
// arguments actually closed; a half-streamed call is dropped rather than dispatched with junk.
// stop_reason: tool_use when a call survives (the loop dispatches it and continues); max_tokens when
// only text survives (the run ends done with the partial answer visible — same as a provider cap).
//
// Thinking alone does NOT count — same rule the run loop applies. Salvaging a thinking-only turn
// would record it and then fail with "produced no answer", hiding that the real cause was the
// deadline; letting the abort through surfaces the timeout instead.
// A tool call counts as closed only when `input` is set: the Anthropic consumer sets it on
// content_block_stop (the placeholder is dropped at block open), the OpenAI one in settleToolsStrict.
export function salvageContent(blocks) {
  const kept = blocks.filter(b => b && (b.type !== "tool_use" || b.input !== undefined));
  const hasTools = kept.some(b => b.type === "tool_use");
  const usable = hasTools
    || kept.some(b => b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
  return usable ? { content: kept, stop_reason: hasTools ? "tool_use" : "max_tokens" } : null;
}

export function safeEmit(onDelta) {
  return (e) => { try { onDelta?.(e); } catch { /* a consumer error must not break the stream */ } };
}

// The one gate every response passes, whichever wire shape produced it. It checks only the invariants
// the DO state machine needs — a run recorded without them is corrupt, not merely odd — and is
// deliberately not a protocol conformance check: malformed provider output fails the run on its own,
// and defending that space never converges.
export function finalizeResponse(parsed, onDelta) {
  const stop = parsed?.stop_reason;
  if (typeof stop !== "string" || stop === "") throw new Error("LLM response missing a valid stop_reason");
  const content = Array.isArray(parsed?.content) ? parsed.content : [];
  const toolUses = content.filter(b => b?.type === "tool_use");
  if (toolUses.some(b => typeof b.id !== "string" || b.id === "")) {
    throw new Error("LLM response: tool_use missing id");
  }
  if (!hasRenderableContent(content)) throw new Error("LLM response has no displayable content");
  safeEmit(onDelta)({ type: "message_complete", stop_reason: stop });
  return parsed;
}

// An assistant message with nothing to render is recorded as a successful blank reply, which reads
// as the agent silently doing nothing.
function hasRenderableContent(content) {
  return (content ?? []).some(b =>
    (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "")
    || (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim() !== "")
    || b?.type === "tool_use");
}

// Absent or empty means "no arguments". Arguments truncated by the token cap are routine, so a parse
// failure degrades to {} and lets the tool reject it — the model then self-corrects within the same
// run, where throwing here would fail the run and discard the assistant turn with it.
export function parseToolInput(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;   // some gateways deliver it pre-parsed
  try { return JSON.parse(raw); } catch { return {}; }
}

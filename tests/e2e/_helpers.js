// Shared helpers for tests/e2e/* — the demos need a real running stack
// (chat-frontend + chat-worker + sandbox-broker + MicroVM image + LLM).
//
// Set WDL_CHAT_BASE_URL to e.g. https://chat.test-workers.example.com to
// run them; otherwise the test files mark themselves skipped.

export const BASE = process.env.WDL_CHAT_BASE_URL ?? null;
export const PASSCODE = process.env.WDL_CHAT_PASSCODE ?? null;
export const HAS_E2E_BASE = Boolean(BASE);

// Sessions are minted through the passcode-gated portal.
export async function createSession() {
  const r = await fetch(`${BASE}/api/portal/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  if (!r.ok) throw new Error(`createSession failed ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function postMessage(sessionId, content) {
  const r = await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`postMessage failed ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function closeSession(sessionId) {
  try {
    await fetch(`${BASE}/api/sessions/${sessionId}/close`, { method: "POST" });
  } catch { /* best-effort */ }
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const raw of block.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  let data = dataLines.join("\n");
  try { data = JSON.parse(data); } catch { /* keep as string */ }
  return { event, data };
}

export async function* streamEvents(sessionId, signal) {
  const r = await fetch(`${BASE}/api/sessions/${sessionId}/stream`, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!r.ok) throw new Error(`stream connect failed ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (ev) yield ev;
    }
  }
}

export async function awaitRunDone(sessionId, runId, { timeoutMs = 5 * 60_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events = [];
  let preview = null;
  let assistantText = "";
  try {
    for await (const ev of streamEvents(sessionId, ac.signal)) {
      events.push(ev);
      if (ev.event === "preview.ready") preview = ev.data;
      if (ev.event === "message.assistant" && Array.isArray(ev.data?.content) && !ev.data?.replay) {
        for (const b of ev.data.content) {
          if (b?.type === "text" && b.text) assistantText += b.text + "\n";
        }
      }
      if (
        (ev.event === "run.done" || ev.event === "run.failed" || ev.event === "run.aborted") &&
        ev.data?.runId === runId
      ) {
        return { events, preview, assistantText, terminal: ev };
      }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      throw new Error(`awaitRunDone timed out after ${timeoutMs}ms; saw ${events.length} events`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`stream closed before terminal event; saw ${events.length} events`);
}

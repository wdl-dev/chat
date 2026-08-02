// Stream fixtures shared by the llm tests. Not a test file — the npm test glob
// only picks up *.test.js.

export const streamFromString = (text) => streamFromChunks([text]);

export function streamFromChunks(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

// Delivers `text`, then errors — models a stream cut short (budget abort, dropped connection).
// Errors on a later pull rather than in start(): controller.error() discards anything still queued.
export function streamThenError(text, err = new Error("aborted")) {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(c) {
      if (!sent) { sent = true; c.enqueue(enc.encode(text)); return; }
      c.error(err);
    },
  });
}

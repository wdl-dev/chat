import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function makeEnv(over = {}) {
  return {
    ASSETS: { url: async (p) => `https://cdn.example/assets/${p}` },
    CHAT: { fetch: async () => new Response("ok") },
    ...over,
  };
}
const req = (method, path, init = {}) => new Request(`https://chat.local${path}`, { method, ...init });

test("/api/* is proxied to CHAT with the /api prefix stripped, method preserved", async () => {
  let seen = null;
  const env = makeEnv({ CHAT: { fetch: async (r) => { seen = { path: new URL(r.url).pathname, method: r.method }; return new Response("ok"); } } });
  await worker.fetch(req("POST", "/api/sessions/s1/messages"), env);
  assert.deepEqual(seen, { path: "/sessions/s1/messages", method: "POST" });
});

test("GET / returns the SPA shell with a locked-down content-security-policy", async () => {
  const res = await worker.fetch(req("GET", "/"), makeEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  // CDN origin (derived from ASSETS.url) drives script-src/style-src.
  assert.match(csp, /script-src https:\/\/cdn\.example/);
  assert.match(csp, /style-src https:\/\/cdn\.example 'unsafe-inline'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await res.text();
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /src="https:\/\/cdn\.example\/assets\/app\.js"/);
});

test("a non-/api, non-root path 404s", async () => {
  const res = await worker.fetch(req("GET", "/whatever"), makeEnv());
  assert.equal(res.status, 404);
});

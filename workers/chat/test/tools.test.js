import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchTool, uploadAsset, __test__ } from "../src/tools.js";

const { parseSseBlock, clampInt, runsWdlInitCommand } = __test__;

function makeCtx(overrides = {}) {
  let preview = null;
  return {
    env: {
      ADMIN_URL: "https://api.wdl.dev",
      PLATFORM_DOMAIN: "wdl.sh",
    },
    sessionId: "sess-1",
    ns: "tmp-1234",
    nsToken: "ns-tok",
    // Populated by the DO (broker.openSession) before tools run.
    endpoint: "mvm-abc.lambda-microvm.ap-northeast-1.on.aws",
    authToken: "jwe-tok",
    previewUrl: () => preview,
    setPreviewUrl: (url) => { preview = url; },
    ...overrides,
  };
}

function makeFetcher(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const route = routes(url, init) || { ok: true, status: 200, body: {} };
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      async text() { return typeof route.body === "string" ? route.body : JSON.stringify(route.body); },
      async json() { return route.body; },
      headers: new Map(),
      body: route.streamBody ?? null,
    };
  };
  return { fetcher, calls };
}

// A ReadableStream-ish body for the tail SSE path: yields each block then done.
function sseStream(blocks) {
  let i = 0;
  const enc = new TextEncoder();
  return { getReader: () => ({ read: async () => (i < blocks.length ? { done: false, value: enc.encode(blocks[i++]) } : { done: true }) }) };
}

function sseErrorStream(blocks, err = new Error("midstream boom")) {
  let i = 0;
  const enc = new TextEncoder();
  return { getReader: () => ({ read: async () => { if (i < blocks.length) return { done: false, value: enc.encode(blocks[i++]) }; throw err; } }) };
}

test("clampInt clamps + falls back to default", () => {
  assert.equal(clampInt(5, 0, 10, 1), 5);
  assert.equal(clampInt(-3, 0, 10, 1), 0);
  assert.equal(clampInt(99, 0, 10, 1), 10);
  assert.equal(clampInt(undefined, 0, 10, 1), 1);
  assert.equal(clampInt("abc", 0, 10, 1), 1);
  assert.equal(clampInt(NaN, 0, 10, 1), 1);
  assert.equal(clampInt(7.9, 0, 10, 1), 7);
});

test("parseSseBlock joins data lines and strips one leading space", () => {
  const ev = parseSseBlock("event: x\ndata: {\"a\":1}\n");
  assert.equal(ev.event, "x");
  assert.deepEqual(ev.data, { a: 1 });

  const multi = parseSseBlock("event: y\ndata: line1\ndata: line2");
  assert.equal(multi.event, "y");
  assert.equal(multi.data, "line1\nline2");
});

test("dispatchTool unknown name returns error", async () => {
  const r = await dispatchTool({ name: "nonsense", input: {}, ctx: makeCtx(), signal: undefined, fetcher: () => null });
  assert.deepEqual(r, { error: "unknown tool: nonsense" });
});

test("read_file routes to GET /read-file?sessionId&path on the MicroVM with the JWE", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { path: "/workspace/x", content: "hi" } }));
  await dispatchTool({ name: "read_file", input: { path: "/workspace/x" }, ctx: makeCtx(), signal: undefined, fetcher });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/mvm-abc[^/]*\/read-file\?sessionId=sess-1&path=%2Fworkspace%2Fx$/);
  assert.equal(calls[0].init.headers["X-aws-proxy-auth"], "jwe-tok");
});

test("write_file POSTs JSON body to /write-file with sessionId, path, content", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { ok: true } }));
  await dispatchTool({
    name: "write_file",
    input: { path: "src/x.js", content: "export default {}" },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  assert.match(calls[0].url, /\/write-file$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { sessionId: "sess-1", path: "src/x.js", content: "export default {}" });
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers["X-aws-proxy-auth"], "jwe-tok");
});

test("write_file omits encoding by default and passes encoding:base64 when set", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { ok: true } }));
  await dispatchTool({ name: "write_file", input: { path: "a.txt", content: "x" }, ctx: makeCtx(), fetcher });
  assert.equal(JSON.parse(calls[0].init.body).encoding, undefined);

  await dispatchTool({ name: "write_file", input: { path: "a.bin", content: "AAA=", encoding: "base64" }, ctx: makeCtx(), fetcher });
  assert.equal(JSON.parse(calls[1].init.body).encoding, "base64");
});

test("uploadAsset writes base64 under assets/ via /write-file", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { ok: true, path: "/workspace/assets/logo.png", bytes: 3 } }));
  const r = await uploadAsset(makeCtx(), "logo.png", "AAEC", undefined, fetcher);
  assert.match(calls[0].url, /\/write-file$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { sessionId: "sess-1", path: "assets/logo.png", content: "AAEC", encoding: "base64" });
  assert.equal(r.bytes, 3);
});

test("run_command sends sessionId + cmd + timeoutSec only (agent injects env via /init)", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
  await dispatchTool({
    name: "run_command",
    input: { cmd: "ls", timeoutSec: 30 },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  assert.match(calls[0].url, /\/run$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { sessionId: "sess-1", cmd: "ls", timeoutSec: 30 });
  assert.equal(body.env, undefined);
  assert.equal(calls[0].init.headers["X-aws-proxy-auth"], "jwe-tok");
});

test("run_command timeoutSec clamps to the 45s cap", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
  await dispatchTool({
    name: "run_command",
    input: { cmd: "ls", timeoutSec: 600 },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  assert.equal(JSON.parse(calls[0].init.body).timeoutSec, 45);
});

test("run_command refuses npm / yarn install variants without hitting the agent", async () => {
  const blocked = [
    "npm install",
    "npm i",
    "npm i react",
    "yarn install",
    "yarn add eslint",
    "sudo npm install",
    "npm ci",
    // Shell-wrapper bypasses must also reject
    "cd /workspace && npm install",
    "cd /workspace && yarn add eslint",
    "bash -c 'npm install'",
    'bash -c "npm install"',
    "bash -lc 'npm i react'",
    "ls && npm ci",
    "true; npm install",
    "true || yarn install",
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 0, `agent was called for "${cmd}"`);
    assert.match(String(out?.error ?? ""), /blocked/);
  }
});

test("run_command allows pnpm install / add / i (supported pkg manager)", async () => {
  const ok = ["pnpm install", "pnpm i", "  pnpm install ", "pnpm add lodash", "pnpm add -D eslint"];
  for (const cmd of ok) {
    const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
    await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 1, `agent not called for "${cmd}"`);
  }
});

test("run_command refuses wdl deploy / pack / tail without hitting the agent", async () => {
  const blocked = [
    "wdl deploy .",
    "  wdl deploy . --env uat",
    "wdl pack .",
    "wdl tail --workers app",
    // Shell-wrapper bypasses must also reject
    "cd /workspace && wdl deploy .",
    "cd /workspace && wdl pack .",
    "bash -c 'wdl tail --worker app'",
    'bash -c "wdl deploy ."',
    "bash -lc 'wdl tail --worker app'",
    "ls && wdl deploy .",
    "true; wdl pack .",
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 0, `agent was called for "${cmd}"`);
    assert.match(String(out?.error ?? ""), /blocked/);
  }
});

test("run_command allows other wdl subcommands (d1, r2, secret, workers)", async () => {
  const ok = ["wdl d1 create my-db", "wdl r2 buckets list", "wdl secret put", "wdl workers", "wdl --help"];
  for (const cmd of ok) {
    const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
    await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 1, `agent not called for "${cmd}"`);
  }
});

test("run_command after `wdl init` overwrites /workspace/AGENTS.md and probes package.json", async () => {
  const { fetcher, calls } = makeFetcher((url) => {
    if (url.endsWith("/run")) return { body: { exitCode: 0, stdout: "", stderr: "" } };
    if (url.endsWith("/write-file")) return { body: { ok: true } };
    if (url.includes("/read-file")) return { body: {} }; // no content -> strip is a no-op
    return null;
  });
  await dispatchTool({
    name: "run_command",
    input: { cmd: "wdl init . --ns $WDL_NS" },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  // 1) /run, 2) /write-file AGENTS.md, 3) /read-file package.json (strip probe)
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/run$/);
  assert.match(calls[1].url, /\/write-file$/);
  const writeBody = JSON.parse(calls[1].init.body);
  assert.equal(writeBody.path, "/workspace/AGENTS.md");
  assert.match(writeBody.content, /^# AGENTS\.md/);
  // No ctx.language -> the default English doc ("Tool cheatsheet" is EN-only).
  assert.match(writeBody.content, /Tool cheatsheet/);
  assert.match(calls[2].url, /\/read-file\?sessionId=sess-1&path=%2Fworkspace%2Fpackage\.json$/);
});

test("run_command after `wdl init` injects the Chinese AGENTS.md when ctx.language is zh", async () => {
  const { fetcher, calls } = makeFetcher((url) => {
    if (url.endsWith("/run")) return { body: { exitCode: 0, stdout: "", stderr: "" } };
    if (url.endsWith("/write-file")) return { body: { ok: true } };
    if (url.includes("/read-file")) return { body: {} };
    return null;
  });
  await dispatchTool({
    name: "run_command",
    input: { cmd: "wdl init . --ns $WDL_NS" },
    ctx: makeCtx({ language: "zh" }),
    signal: undefined,
    fetcher,
  });
  const writeBody = JSON.parse(calls[1].init.body);
  assert.equal(writeBody.path, "/workspace/AGENTS.md");
  assert.match(writeBody.content, /工具速查/);          // zh-only heading
  assert.doesNotMatch(writeBody.content, /Tool cheatsheet/);
});

test("runsWdlInitCommand: positive cases (real shell-wrapped init invocations)", () => {
  for (const cmd of [
    "wdl init",
    "wdl init . --ns x",
    "  wdl init",
    "cd /workspace && wdl init",
    "cd /workspace && wdl init . --ns $WDL_NS",
    'cd /workspace && wdl init . --ns "$WDL_NS"',
    "cd /workspace; wdl init .",
    "true || wdl init",
    "ls | wdl init",
    "sudo wdl init",
    "WDL_NS=foo wdl init",
    'bash -c "wdl init ."',
    "bash -c 'cd /workspace && wdl init .'",
    'bash -lc "wdl init ."',          // combined flag
    'bash -l -c "wdl init ."',        // separate flag
    'bash --norc -c "wdl init"',      // long flag between
    'bash -o pipefail -c "wdl init"', // flag with value (-o pipefail)
    'bash --rcfile /tmp/x -c "wdl init"',
    "sh -c 'wdl init'",
    "sh -lc 'wdl init'",
  ]) {
    assert.equal(runsWdlInitCommand(cmd), true, `should detect: ${cmd}`);
  }
});

test("runsWdlInitCommand: negative cases (string literals / args / search)", () => {
  for (const cmd of [
    'printf "wdl init"',
    'grep "wdl init" /opt/wdl-cli/docs/init.md',
    'grep -r "wdl init" /workspace/',
    "echo wdl init",
    'echo "wdl init"',
    'cat <<EOF\nwdl init\nEOF',
    "cat /opt/wdl-cli/docs/init.md",  // mentions init in path, not as command
    "ls /workspace/wdl-init-output",   // dirname has 'init' but not 'wdl<space>init'
    "git log --grep 'wdl init'",
    'find . -name "*wdl init*"',
    "wdl initialize",  // word-boundary mismatch
    "mywdl init",       // starts with mywdl, segment start mismatch
    'echo "x; wdl init"',          // ; inside quotes, must not split
    'printf "x && wdl init"',       // && inside quotes
    'grep "x | wdl init" file',     // | inside quotes
    "echo 'a; wdl init; b'",        // single-quoted ; should not split
    'bash script.sh "wdl init"',    // quoted arg to a script, NOT -c
    'sh ./script "wdl init"',       // same, sh
    'bash -c-notreally "wdl init"', // not a real -c flag
    'bash --version "wdl init"',    // --version, no -c
    'bash foo -c "wdl init"',       // foo is positional (script), aborts before -c
    'bash foo bar -c "wdl init"',   // same, two positional args
    'bash -- -c "wdl init"',        // -- ends options, -c is positional
    'env bash -c "wdl init"',       // env wrapper not unwrapped (out of scope)
    "",                 // empty
    null,               // non-string
    undefined,
  ]) {
    assert.equal(runsWdlInitCommand(cmd), false, `should NOT detect: ${cmd}`);
  }
});

test("run_command after shell-wrapped `wdl init` (cd && / bash -c) still overwrites AGENTS.md", async () => {
  for (const cmd of [
    'cd /workspace && wdl init . --ns "$WDL_NS"',
    'bash -c "wdl init ."',
    'cd /workspace; wdl init .',
  ]) {
    const { fetcher, calls } = makeFetcher((url) => {
      if (url.endsWith("/run")) return { body: { exitCode: 0, stdout: "", stderr: "" } };
      if (url.endsWith("/write-file")) return { body: { ok: true } };
      if (url.includes("/read-file")) return { body: {} };
      return null;
    });
    await dispatchTool({ name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher });
    const writeFileCall = calls.find(c => c.url.endsWith("/write-file"));
    assert.ok(writeFileCall, `expected /write-file after cmd: ${cmd}`);
    const body = JSON.parse(writeFileCall.init.body);
    assert.equal(body.path, "/workspace/AGENTS.md");
    assert.match(body.content, /^# AGENTS\.md/);
  }
});

test("run_command after `wdl init` strips deploy / deploy:* scripts when package.json has them", async () => {
  const scaffolded = {
    name: "demo",
    scripts: {
      deploy: "wdl deploy . --env uat --ns acme",
      "deploy:prod": "wdl deploy . --env production --ns acme",
      "dry-run": "wrangler deploy --dry-run --outdir=.deploy-dist",
    },
    devDependencies: { wrangler: "^4" },
  };
  const { fetcher, calls } = makeFetcher((url) => {
    if (url.endsWith("/run")) return { body: { exitCode: 0, stdout: "", stderr: "" } };
    if (url.includes("/read-file")) return { body: { path: "/workspace/package.json", content: JSON.stringify(scaffolded) } };
    if (url.endsWith("/write-file")) return { body: { ok: true } };
    return null;
  });
  await dispatchTool({
    name: "run_command",
    input: { cmd: "wdl init . --ns $WDL_NS" },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  // run, writeFile AGENTS.md, readFile package.json, writeFile package.json
  assert.equal(calls.length, 4);
  const lastWrite = calls[3];
  assert.match(lastWrite.url, /\/write-file$/);
  const body = JSON.parse(lastWrite.init.body);
  assert.equal(body.path, "/workspace/package.json");
  const rewritten = JSON.parse(body.content);
  assert.equal(rewritten.scripts.deploy, undefined);
  assert.equal(rewritten.scripts["deploy:prod"], undefined);
  assert.equal(rewritten.scripts["dry-run"], "wrangler deploy --dry-run --outdir=.deploy-dist");
  assert.equal(rewritten.devDependencies.wrangler, "^4");
});

test("run_command after `wdl init` does NOT writeFile package.json when scripts already clean", async () => {
  const cleanPkg = { name: "demo", scripts: { "dry-run": "wrangler deploy --dry-run" } };
  const { fetcher, calls } = makeFetcher((url) => {
    if (url.endsWith("/run")) return { body: { exitCode: 0, stdout: "", stderr: "" } };
    if (url.includes("/read-file")) return { body: { path: "/workspace/package.json", content: JSON.stringify(cleanPkg) } };
    if (url.endsWith("/write-file")) return { body: { ok: true } };
    return null;
  });
  await dispatchTool({
    name: "run_command",
    input: { cmd: "wdl init . --ns $WDL_NS" },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  // run + writeFile AGENTS.md + readFile package.json — no second writeFile.
  assert.equal(calls.length, 3);
});

test("run_command after a FAILED wdl init (non-zero exit) does NOT touch AGENTS.md or package.json", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 2, stdout: "", stderr: "init failed" } }));
  await dispatchTool({
    name: "run_command",
    input: { cmd: "wdl init . --ns $WDL_NS" },
    ctx: makeCtx(),
    signal: undefined,
    fetcher,
  });
  assert.equal(calls.length, 1, "no follow-up calls when init exited non-zero");
});

test("run_command refuses wrangler deploy in any wrapping (npx, pnpm exec, bash -c, &&-chain)", async () => {
  const blocked = [
    "wrangler deploy",
    "wrangler deploy --dry-run=false",
    "wrangler deploy --dry-run false",
    "wrangler deploy --dry-run=0",
    "npx wrangler deploy",
    "pnpm exec wrangler deploy",
    "env npx wrangler deploy",
    "env pnpm exec wrangler deploy",
    "env bunx wrangler deploy",
    "bash -c 'wrangler deploy'",
    "cd /workspace && wrangler deploy",
    // chaining: real deploy followed by a dry-run that tries to cover for it
    "wrangler deploy && wrangler deploy --dry-run",
    "wrangler deploy --dry-run && wrangler deploy",
    "wrangler deploy; wrangler deploy --dry-run",
    // multiple dry-runs is also blocked (unusual + ambiguous)
    "wrangler deploy --dry-run && wrangler deploy --dry-run",
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 0, `agent was called for "${cmd}"`);
    assert.match(String(out?.error ?? ""), /blocked/);
  }
});

test("run_command splits on newlines so a blocked command on its own line is seen", async () => {
  const blocked = [
    "ls\nnpm install",                       // second line was invisible before
    "true\nwdl deploy .",
    "echo hi\nnpm install",
    "npm \\\ninstall",                       // line continuation must join, not hide the split
    "cat <<EOF\nfoo\nEOF\nwdl deploy .",     // command AFTER a heredoc is still seen
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({ name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher });
    assert.equal(calls.length, 0, `agent called for ${JSON.stringify(cmd)}`);
    assert.match(String(out?.error ?? ""), /blocked/);
  }
  // A blocked word INSIDE a heredoc body is literal text, not a command — must NOT be flagged.
  const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
  const ok = await dispatchTool({
    name: "run_command",
    input: { cmd: "cat <<EOF\nnpm install\nEOF" },
    ctx: makeCtx(), signal: undefined, fetcher,
  });
  assert.doesNotMatch(String(ok?.error ?? ""), /blocked/, "heredoc body should not be scanned as commands");
  assert.equal(calls.length, 1, "the cat-with-heredoc command should actually run");
});

test("run_command fails closed on pathologically nested commands (recursion cap)", async () => {
  // Command substitution nested past the parser's recursion cap must be blocked, not silently
  // let through with zero parsed argv (which would bypass every command guard).
  const cmd = "$(".repeat(8) + "echo hi" + ")".repeat(8);
  const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
  const out = await dispatchTool({ name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher });
  assert.equal(calls.length, 0, "agent must not be called for an over-nested command");
  assert.match(String(out?.error ?? ""), /too deep|blocked/);
});

test("run_command guards see through command substitution", async () => {
  const blocked = [
    "echo $(npm install)",            // $() substitution body
    "echo $(wrangler deploy)",
    "`npm i`",                        // backtick substitution
    "echo \"$(wrangler deploy)\"",    // substitution inside double quotes
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({
      name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher,
    });
    assert.equal(calls.length, 0, `agent was called for ${JSON.stringify(cmd)}`);
    assert.match(String(out?.error ?? ""), /blocked/, `not blocked: ${JSON.stringify(cmd)}`);
  }
});

test("run_command does NOT misfire on heredoc / here-string doc writes", async () => {
  // A heredoc body is literal stdin data: backticks/commands inside it must not
  // be scanned (over-block regression), and a heredoc/here-string must not
  // swallow chained commands or be misparsed as `<<<` (under-detect regression).
  const allowed = [
    "cat > README.md <<'EOF'\nInstall: `npm install`\nthen `wrangler deploy`\nEOF",
    "cat <<EOF\nwdl init notes\nEOF",
    "tr a b <<< hello",
    // operator + blocked-looking command INSIDE a heredoc body must not be split/rejected
    "cat > setup.sh <<'EOF'\necho start; npm install\nrun && yarn add x\nEOF",
  ];
  for (const cmd of allowed) {
    const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
    const out = await dispatchTool({
      name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher,
    });
    assert.equal(out?.error ?? null, null, `wrongly blocked: ${JSON.stringify(cmd)} -> ${out?.error}`);
    assert.ok(calls.length > 0, `agent not reached for ${JSON.stringify(cmd)}`);
  }
  // ...but a real blocked command CHAINED after a here-string is still caught.
  for (const cmd of ["tr a b <<< X; npm install", "cat <<< x\ntrue; npm install"]) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({
      name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher,
    });
    assert.equal(calls.length, 0, `agent reached for chained npm install: ${JSON.stringify(cmd)}`);
    assert.match(String(out?.error ?? ""), /blocked/);
  }
});

test("run_command does not misfire on 'wrangler deploy' appearing as plain arguments", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
  const out = await dispatchTool({
    name: "run_command", input: { cmd: "echo wrangler deploy is blocked" }, ctx: makeCtx(), signal: undefined, fetcher,
  });
  assert.equal(out?.error ?? null, null, "echo of the words must not be blocked");
  assert.equal(calls.length, 1);

  // but a real env-prefixed wrangler deploy is still caught
  const blocked = await dispatchTool({
    name: "run_command", input: { cmd: "env FOO=1 wrangler deploy" }, ctx: makeCtx(), signal: undefined,
    fetcher: () => { throw new Error("should not call agent"); },
  });
  assert.match(String(blocked?.error ?? ""), /blocked|wrangler/);
});

test("run_command allows a single wrangler deploy --dry-run for bundle inspection", async () => {
  // Allow form: exactly one wrangler deploy in cmd, segment carries
  // --dry-run with no falsey value.
  const ok = [
    "wrangler deploy --dry-run --outdir=.deploy-dist",
    "wrangler deploy --outdir=.deploy-dist --dry-run",
    "wrangler deploy --dry-run=true --outdir=.deploy-dist",
    "wrangler deploy --dry-run=1",
    "npx wrangler deploy --dry-run --outdir=.deploy-dist",
    "pnpm exec wrangler deploy --dry-run",
    "cd /workspace && wrangler deploy --dry-run",
  ];
  for (const cmd of ok) {
    const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
    await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 1, `agent not called for "${cmd}"`);
  }
});

test("run_command refuses (pnpm|npm|yarn) [run] deploy[:variant] without hitting the agent", async () => {
  const blocked = [
    "pnpm run deploy",
    "pnpm deploy",
    "pnpm run deploy:prod",
    "npm run deploy",
    "npm run deploy:prod",
    "yarn run deploy",
    "yarn deploy",
    // Shell-wrapper bypasses must also reject
    "cd /workspace && pnpm run deploy",
    "cd /workspace && pnpm deploy",
    "bash -c 'pnpm run deploy'",
    'bash -c "npm run deploy:prod"',
    "ls && pnpm run deploy",
    "true; yarn deploy",
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 0, `agent was called for "${cmd}"`);
    assert.match(String(out?.error ?? ""), /blocked/);
  }
});

test("run_command lets harmless pnpm scripts through (test, dry-run, build)", async () => {
  const ok = ["pnpm test", "pnpm run dry-run", "pnpm run build", "pnpm run lint"];
  for (const cmd of ok) {
    const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
    await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 1, `agent not called for "${cmd}"`);
  }
});

test("run_command sees through quote/escape obfuscation (parser, not raw regex)", async () => {
  const blocked = [
    'np""m install',
    "np''m i react",
    'n\\pm install',
    '"npm" install',
    '"wdl" deploy .',
    "w\\dl deploy .",
    'wdl dep""loy .',
    'pnpm run dep\\loy',
    '"wrangler" deploy',
    "wrangler dep\\loy",
  ];
  for (const cmd of blocked) {
    const { fetcher, calls } = makeFetcher(() => { throw new Error("should not call agent"); });
    const out = await dispatchTool({ name: "run_command", input: { cmd }, ctx: makeCtx(), signal: undefined, fetcher });
    assert.equal(calls.length, 0, `agent was called for "${cmd}"`);
    assert.match(String(out?.error ?? ""), /blocked/, `not blocked: "${cmd}"`);
  }
});

test("runsWdlInitCommand sees through quote/escape obfuscation", () => {
  for (const cmd of ['wd""l init', "w\\dl init", '"wdl" init .', 'FOO="a b" wdl init', "wdl in''it"]) {
    assert.equal(runsWdlInitCommand(cmd), true, `should detect obfuscated init: ${cmd}`);
  }
});

test("run_command lets non-install commands through (rg, find, ls, cat)", async () => {
  const ok = ["rg foo", "find /workspace", "ls -la", "cat src/index.js", "git status"];
  for (const cmd of ok) {
    const { fetcher, calls } = makeFetcher(() => ({ body: { exitCode: 0, stdout: "", stderr: "" } }));
    await dispatchTool({
      name: "run_command",
      input: { cmd },
      ctx: makeCtx(),
      signal: undefined,
      fetcher,
    });
    assert.equal(calls.length, 1, `agent not called for "${cmd}"`);
  }
});

test("deploy_test packs on the MicroVM then deploys + promotes via control", async () => {
  const ctx = makeCtx();
  const { fetcher, calls } = makeFetcher((url) => {
    if (url.endsWith("/package")) return { body: { mainModule: "index.js", modules: { "index.js": "x" }, assets: {} } };
    if (url.endsWith("/deploy")) return { body: { version: "v3" } };
    if (url.endsWith("/promote")) return { body: { ok: true } };
    return null;
  });
  const out = await dispatchTool({ name: "deploy_test", input: {}, ctx, signal: undefined, fetcher });
  assert.equal(out.versionId, "v3");
  assert.equal(out.previewUrl, "https://tmp-1234.wdl.sh/app/");
  assert.equal(ctx.previewUrl(), "https://tmp-1234.wdl.sh/app/");
  // /package on the MicroVM, then control deploy + promote carrying the ns token.
  assert.match(calls[0].url, /\/package$/);
  assert.match(calls[1].url, /\/ns\/tmp-1234\/worker\/app\/deploy$/);
  assert.equal(calls[1].init.headers["x-admin-token"], "ns-tok");
  assert.match(calls[2].url, /\/ns\/tmp-1234\/worker\/app\/promote$/);
});

test("call_preview rejects when no previewUrl yet", async () => {
  const ctx = makeCtx();
  const r = await dispatchTool({ name: "call_preview", input: { path: "/" }, ctx, signal: undefined, fetcher: () => null });
  assert.match(r.error, /run deploy_test first/);
});

test("call_preview hits the cached preview URL with method + body (capture_logs:false)", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const { fetcher, calls } = makeFetcher(() => ({ body: { hello: "world" } }));
  await dispatchTool({
    name: "call_preview",
    input: { path: "/api", method: "POST", body: { name: "x" }, capture_logs: false },
    ctx, signal: undefined, fetcher,
  });
  assert.equal(calls.length, 1, "should not open tail when capture_logs is false");
  assert.equal(calls[0].url, "https://tmp-1234.workers.example/app/api");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.body, '{"name":"x"}');
});

test("call_preview caps an oversized preview body and flags body_truncated", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const big = new TextEncoder().encode("x".repeat(300 * 1024)); // 300KB > 256KB cap
  const { fetcher } = makeFetcher(() => ({ ok: true, status: 200, streamBody: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }) }));
  const r = await dispatchTool({ name: "call_preview", input: { path: "/", capture_logs: false }, ctx, signal: undefined, fetcher });
  assert.equal(r.body_truncated, true);
  assert.ok(new TextEncoder().encode(String(r.body)).byteLength <= 256 * 1024, "body must be capped to <= 256KB");
});

test("call_preview does NOT flag body_truncated for an exactly-256KB body", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const exact = new TextEncoder().encode("x".repeat(256 * 1024)); // exactly the cap — complete, not truncated
  const { fetcher } = makeFetcher(() => ({ ok: true, status: 200, streamBody: new ReadableStream({ start(c) { c.enqueue(exact); c.close(); } }) }));
  const r = await dispatchTool({ name: "call_preview", input: { path: "/", capture_logs: false }, ctx, signal: undefined, fetcher });
  assert.notEqual(r.body_truncated, true);
});

test("tail_logs aborts the control tail stream after hitting maxEvents (no leaked connection)", async () => {
  const ctx = makeCtx();
  let capturedSignal = null;
  const blocks = ["event: x\ndata: 1\n\n", "event: x\ndata: 2\n\n", "event: x\ndata: 3\n\n"];
  const fetcher = async (_url, init) => { capturedSignal = init?.signal; return { ok: true, status: 200, body: sseStream(blocks) }; };
  const r = await dispatchTool({ name: "tail_logs", input: { maxEvents: 1 }, ctx, signal: undefined, fetcher });
  assert.equal(r.truncated, "maxEvents");
  assert.equal(r.events.length, 1);
  assert.ok(capturedSignal?.aborted, "control tail stream signal must be aborted after the cap, or the connection leaks");
});

test("call_preview rejects a path that escapes the /app/ mount", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const { fetcher, calls } = makeFetcher(() => ({ ok: true, status: 200, body: {} }));
  const r = await dispatchTool({ name: "call_preview", input: { path: "../admin", capture_logs: false }, ctx, signal: undefined, fetcher });
  assert.ok(r.error && /escapes/.test(r.error), `expected an escape error, got ${JSON.stringify(r)}`);
  assert.equal(calls.length, 0, "must not fetch a path outside the mount");
});

test("call_preview default opens tail before fetch and falls back gracefully when tail body is unstreamable", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const { fetcher, calls } = makeFetcher((url) => {
    if (url.includes("/logs/tail")) return { ok: true, status: 200, body: "" }; // mock has no streamBody, so reader is null
    return { ok: true, status: 200, body: { ok: true } };
  });
  const out = await dispatchTool({
    name: "call_preview",
    input: { path: "/" },
    ctx, signal: undefined, fetcher, sleep: () => Promise.resolve(),
  });
  // Two calls: tail open, then preview fetch.
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/logs\/tail/);
  assert.match(calls[0].url, /\?worker=app$/);
  assert.equal(calls[1].url, "https://tmp-1234.workers.example/app/");
  // No body reader → empty events + logs_error explaining why.
  assert.deepEqual(out.logs, []);
  assert.match(out.logs_error ?? "", /no reader/);
});

test("call_preview tail fetch failure surfaces in logs_error without breaking response", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const { fetcher } = makeFetcher((url) => {
    if (url.includes("/logs/tail")) return { ok: false, status: 401, body: '{"error":"unauthorized"}' };
    return { ok: true, status: 200, body: { ok: true } };
  });
  const out = await dispatchTool({
    name: "call_preview",
    input: { path: "/" },
    ctx, signal: undefined, fetcher, sleep: () => Promise.resolve(),
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true });
  assert.match(out.logs_error, /tail http 401/);
});

test("list_files routes to GET /list-files?sessionId&path with the JWE", async () => {
  const { fetcher, calls } = makeFetcher(() => ({ body: { path: "/workspace", entries: [] } }));
  await dispatchTool({ name: "list_files", input: { path: "/workspace" }, ctx: makeCtx(), signal: undefined, fetcher });
  assert.match(calls[0].url, /\/list-files\?sessionId=sess-1&path=%2Fworkspace$/);
  assert.equal(calls[0].init.headers["X-aws-proxy-auth"], "jwe-tok");
});

test("tail_logs drains the SSE stream into parsed events", async () => {
  const { fetcher } = makeFetcher((url) => url.includes("/logs/tail")
    ? { ok: true, status: 200, streamBody: sseStream(['event: log\ndata: {"m":1}\n\n', 'event: log\ndata: {"m":2}\n\n']) }
    : { ok: true, status: 200, body: {} });
  const out = await dispatchTool({ name: "tail_logs", input: { durationSec: 5 }, ctx: makeCtx(), signal: undefined, fetcher });
  assert.equal(out.error, null);
  assert.equal(out.events.length, 2);
  assert.deepEqual(out.events[0], { event: "log", data: { m: 1 } });
  assert.equal(out.truncated, null);
});

test("tail_logs truncates at maxEvents", async () => {
  const { fetcher } = makeFetcher((url) => url.includes("/logs/tail")
    ? { ok: true, status: 200, streamBody: sseStream(['event: log\ndata: 1\n\n', 'event: log\ndata: 2\n\n', 'event: log\ndata: 3\n\n']) }
    : { ok: true, status: 200, body: {} });
  const out = await dispatchTool({ name: "tail_logs", input: { maxEvents: 2 }, ctx: makeCtx(), fetcher });
  assert.equal(out.events.length, 2);
  assert.equal(out.truncated, "maxEvents");
});

test("tail_logs surfaces an http error from opening the tail", async () => {
  const { fetcher } = makeFetcher(() => ({ ok: false, status: 403, body: "nope" }));
  const out = await dispatchTool({ name: "tail_logs", input: {}, ctx: makeCtx(), fetcher });
  assert.deepEqual(out.events, []);
  assert.match(out.error, /tail http 403/);
});

test("tail_logs surfaces a midstream read error instead of a silent normal end", async () => {
  const ctx = makeCtx();
  const fetcher = async () => ({ ok: true, status: 200, body: sseErrorStream(["event: x\ndata: 1\n\n"]) });
  const r = await dispatchTool({ name: "tail_logs", input: { maxEvents: 50 }, ctx, signal: undefined, fetcher });
  assert.equal(r.events.length, 1, "keeps events read before the error");
  assert.equal(r.truncated, null);
  assert.ok(r.error && /boom/.test(r.error), `expected the read error surfaced, got ${JSON.stringify(r)}`);
});

test("call_preview surfaces a midstream tail read error as logs_error", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const fetcher = async (url) => url.includes("/logs/tail")
    ? { ok: true, status: 200, body: sseErrorStream(["event: x\ndata: 1\n\n"], new Error("tail midstream boom")) }
    : { ok: true, status: 200, body: { hi: 1 } };
  const r = await dispatchTool({ name: "call_preview", input: { path: "/" }, ctx, signal: undefined, fetcher, sleep: async () => {} });
  assert.ok(Array.isArray(r.logs), "logs present");
  assert.ok(r.logs_error && /boom/.test(r.logs_error), `expected logs_error surfaced, got ${JSON.stringify(r)}`);
});

test("call_preview surfaces log truncation as logs_truncated", async () => {
  const ctx = makeCtx();
  ctx.setPreviewUrl("https://tmp-1234.workers.example/app/");
  const blocks = Array.from({ length: 60 }, (_, i) => `event: x\ndata: ${i}\n\n`);
  const fetcher = async (url) => url.includes("/logs/tail")
    ? { ok: true, status: 200, body: sseStream(blocks) }
    : { ok: true, status: 200, body: { hi: 1 } };
  const r = await dispatchTool({ name: "call_preview", input: { path: "/" }, ctx, signal: undefined, fetcher, sleep: async () => {} });
  assert.equal(r.logs.length, 50, "capped at CALL_PREVIEW_TAIL_MAX_EVENTS");
  assert.equal(r.logs_truncated, "maxEvents");
});

test("drainTailSse frames a CRLF-terminated tail stream", async () => {
  const enc = new TextEncoder();
  const chunks = [enc.encode('event: worker_console\r\ndata: {"m":1}\r\n\r\nevent: worker_console\r\ndata: {"m":2}\r\n\r\n')];
  let i = 0;
  const reader = { read: async () => i < chunks.length ? { value: chunks[i++], done: false } : { done: true } };
  const { events, truncated } = await __test__.drainTailSse(reader, { maxEvents: 10, maxBytes: 10000 });
  assert.equal(truncated, null);
  assert.deepEqual(events.map(e => e.data.m), [1, 2]);
});

test("web_search requires a key and a query, and maps the Exa response", async () => {
  const { dispatchTool } = await import("../src/tools.js");
  const noKey = await dispatchTool({ name: "web_search", input: { query: "x" }, ctx: { env: {} } });
  assert.match(noKey.error, /not configured/);

  const ctx = { env: { EXA_API_KEY: "k" } };
  const noQuery = await dispatchTool({ name: "web_search", input: {}, ctx });
  assert.match(noQuery.error, /query required/);

  let captured;
  const fetcher = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [
      { title: "T", url: "https://a", publishedDate: "2026-01-01", highlights: ["h1", "h2"] },
      { title: null, url: "https://b" },
    ] }) };
  };
  const r = await dispatchTool({ name: "web_search", input: { query: "  workerd alarms  ", numResults: 99 }, ctx, fetcher });
  assert.equal(captured.url, "https://api.exa.ai/search");
  assert.equal(captured.init.headers["x-api-key"], "k");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.query, "workerd alarms");
  assert.equal(body.numResults, 8);           // clamped to the max
  assert.deepEqual(body.contents, { highlights: true });
  assert.deepEqual(r.results, [
    { title: "T", url: "https://a", published: "2026-01-01", highlights: ["h1", "h2"] },
    { title: "", url: "https://b", highlights: [] },
  ]);
});

test("web_search surfaces only the status on an HTTP error, and tolerates junk bodies", async () => {
  const { dispatchTool } = await import("../src/tools.js");
  const ctx = { env: { EXA_API_KEY: "k" } };
  const err = await dispatchTool({ name: "web_search", input: { query: "x" }, ctx,
    fetcher: async () => ({ ok: false, status: 402, text: async () => '{"error":"payment","requestId":"r1"}' }) });
  assert.equal(err.error, "search HTTP 402");
  const junk = await dispatchTool({ name: "web_search", input: { query: "x" }, ctx,
    fetcher: async () => ({ ok: true, status: 200, text: async () => "not json" }) });
  assert.match(junk.error, /unexpected shape/);
});

test("web_fetch validates the url, nests text options top-level, and maps statuses on failure", async () => {
  const { dispatchTool } = await import("../src/tools.js");
  const ctx = { env: { EXA_API_KEY: "k" } };
  assert.match((await dispatchTool({ name: "web_fetch", input: {}, ctx })).error, /http\(s\)/);
  assert.match((await dispatchTool({ name: "web_fetch", input: { url: "ftp://x" }, ctx })).error, /http\(s\)/);

  let captured;
  const ok = await dispatchTool({ name: "web_fetch", input: { url: "https://a.dev/x", maxChars: 999999 }, ctx,
    fetcher: async (url, init) => { captured = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ url: "https://a.dev/x", title: "T", text: "body" }] }) }; } });
  assert.equal(captured.url, "https://api.exa.ai/contents");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.urls, ["https://a.dev/x"]);
  assert.deepEqual(body.text, { maxCharacters: 20000, verbosity: "compact" });   // clamped
  assert.deepEqual(ok, { url: "https://a.dev/x", title: "T", text: "body" });

  const miss = await dispatchTool({ name: "web_fetch", input: { url: "https://a.dev/404" }, ctx,
    fetcher: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [], statuses: [{ id: "https://a.dev/404", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }] }) }) });
  assert.match(miss.error, /CRAWL_NOT_FOUND \(404\)/);
});

test("exa deadline and Stop cover the body read, not just the headers", async () => {
  const { dispatchTool } = await import("../src/tools.js");
  const parent = new AbortController();
  // Headers arrive fine; the body hangs until the request's own signal aborts it.
  const fetcher = async (url, init) => ({
    ok: true, status: 200,
    text: () => new Promise((_, reject) => {
      if (init.signal.aborted) return reject(new Error("aborted"));
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const call = dispatchTool({ name: "web_search", input: { query: "x" },
    ctx: { env: { EXA_API_KEY: "k" } }, signal: parent.signal, fetcher });
  setTimeout(() => parent.abort(), 20);
  const r = await call;   // settles only if the parent-abort link outlives the header phase
  assert.match(r.error, /request failed/);
});

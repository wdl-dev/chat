import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { gzipSync } from "node:zlib";

// Loopback-only Chromium regression tests. HTTP is enabled explicitly for the local asset server;
// production keeps the HTTPS default. The two ports are different origins, so module CORS is real.
import { createBrowserJudge } from "./browser-judge.mjs";
import {
  browserOk, currentAssetToken, deployedAssetsOk, rotatedAssetsOk,
} from "./hard-task-logic.mjs";

const TOK = "a".repeat(28);
const TOK2 = "b".repeat(28);
const NS = "tmp-x";
const PAGE = (head, body = "") => `<!doctype html><html><head>${head}</head><body><ul id="l"></ul>${body}</body></html>`;
const APP_JS = `fetch("api/todos").then(r => r.json()).then(d => {
  document.getElementById("l").innerHTML = d.todos.map(t => "<li>" + t.title + "</li>").join("");
});`;
const CSS_TEXT = "body { color: rgb(1, 2, 3); } #l { display: block; }";
const digest = text => createHash("sha256").update(text).digest("hex");
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = server => new Promise(resolve => server.close(resolve));

test("browser judge rejects fail-open or non-finite limits", async () => {
  await assert.rejects(createBrowserJudge({ maxDiagnostics: 0 }), /maxDiagnostics/);
  await assert.rejects(createBrowserJudge({ stabilityWindowMs: Number.NaN }), /stabilityWindowMs/);
});

test("browser judge preserves browser semantics and records execution evidence", async (t) => {
  const assets = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://assets.test").pathname;
    const match = pathname.match(/^\/assets\/tmp-x\/app\/([0-9a-f]{28})\/(.+)$/);
    if (!match) { res.writeHead(404); res.end(); return; }
    const [, token, path] = match;
    // Only this fixture intentionally omits CORS; everything else can also be fetched() in the
    // resource-type regression below.
    if (path !== "module-no-cors.js") res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cache-control", "no-store");
    if (path === "styles.css") {
      res.setHeader("content-type", "text/css");
      res.end(CSS_TEXT);
    } else if (path === "app.js" || path === "module-cors.js" || path === "module-no-cors.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(APP_JS);
    } else if (path === "noop.js") {
      res.setHeader("content-type", "text/javascript");
      res.end('globalThis.__benchNoop = true; fetch("api/todos");');
    } else if (path === "idle.js") {
      res.setHeader("content-type", "text/javascript");
      res.end("globalThis.__canonicalAssetDidNoAppWork = true;");
    } else if (path === "sourceurl-app.js") {
      res.setHeader("content-type", "text/javascript");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(`${APP_JS}\n//# sourceURL=http://${req.headers.host}${req.url}`));
    } else if (path === "transient.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(`fetch("api/todos").then(r => r.json()).then(d => {
        document.getElementById("l").textContent = d.todos.map(t => t.title).join("");
        setTimeout(() => { document.body.textContent = "BROKEN"; throw new Error("late failure"); }, 50);
      });`);
    } else if (path === "responsive.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(`fetch("api/todos").then(r => r.json()).then(d => {
        const text = d.todos.map(t => t.title).join("");
        document.getElementById("hidden-list").textContent = text;
        document.getElementById("visible-list").textContent = text;
      });`);
    } else if (path === "lazy.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(`fetch("api/todos").then(r => r.json()).then(d => {
        document.getElementById("l").textContent = d.todos.map(t => t.title).join("");
        const script = document.createElement("script");
        script.src = globalThis.__lateAssetUrl;
        document.head.append(script);
      });`);
    } else if (path === "worker-app.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(`const worker = new Worker(URL.createObjectURL(new Blob(["postMessage('ready')"], { type: "text/javascript" })));
        worker.onmessage = () => { ${APP_JS} };`);
    } else if (path === "late.js") {
      res.setHeader("content-type", "text/javascript");
      setTimeout(() => res.end("globalThis.__lateAssetLoaded = true;"), 300);
    } else if (path === "broken.js") {
      res.setHeader("content-type", "text/javascript");
      res.end("function broken( {");
    } else if (path === "large.js") {
      res.setHeader("content-type", "text/javascript");
      // Deliberately chunked: there is no Content-Length shortcut, so the streaming cap itself is
      // what prevents this response from entering digest evidence.
      res.write("globalThis.__large = true;/*");
      res.write("x".repeat(6_000));
      res.end("*/");
    } else if (path === "part-a.js" || path === "part-b.js") {
      res.setHeader("content-type", "text/javascript");
      res.write(path === "part-a.js" ? APP_JS : "globalThis.__partB = true;");
      res.write(`/*${"y".repeat(2_600)}*/`);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
    assert.ok(token === TOK || token === TOK2);
  });
  await listen(assets);
  const assetHost = `127.0.0.1:${assets.address().port}`;
  const assetUrl = (token, path) => `http://${assetHost}/assets/${NS}/app/${token}/${path}`;
  const css = token => `<link rel="stylesheet" href="${assetUrl(token, "styles.css")}">`;
  const script = (token, path, attrs = "") => `<script ${attrs} src="${assetUrl(token, path)}"></script>`;

  const preview = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://preview.test").pathname;
    if (pathname.endsWith("/api/todos")) {
      res.setHeader("content-type", "application/json");
      res.end('{"todos":[{"id":1,"title":"persisted-server-row","done":false}]}');
      return;
    }
    if (pathname === "/redirect/") {
      res.writeHead(302, { location: "/redirect/page" });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html");
    if (pathname === "/good/") {
      res.end(PAGE(css(TOK), script(TOK, "app.js")));
    } else if (pathname === "/module/") {
      res.end(PAGE(css(TOK), script(TOK, "module-cors.js", 'type="module"')));
    } else if (pathname === "/cors/") {
      res.end(PAGE(css(TOK), script(TOK, "module-no-cors.js", 'type="module"')));
    } else if (pathname === "/partial/") {
      res.end(PAGE(css(TOK), `${script(TOK, "app.js")}${script(TOK, "module-no-cors.js", 'type="module"')}`));
    } else if (pathname === "/ssr/") {
      res.end(PAGE(css(TOK), `<li>persisted-server-row</li>${script(TOK, "noop.js")}`));
    } else if (pathname === "/broken/") {
      res.end(PAGE(css(TOK), `${script(TOK, "broken.js")}<script>${APP_JS}</script>`));
    } else if (pathname === "/sourceurl/") {
      const appUrl = assetUrl(TOK, "idle.js");
      const inline = `${APP_JS}\n//# sourceURL=${appUrl}`;
      res.end(PAGE(css(TOK), `${script(TOK, "idle.js")}<script>eval(${JSON.stringify(inline)})</script>`));
    } else if (pathname === "/sourceurl-real/") {
      res.end(PAGE(css(TOK), script(TOK, "sourceurl-app.js")));
    } else if (pathname === "/transient/") {
      res.end(PAGE(css(TOK), script(TOK, "transient.js")));
    } else if (pathname === "/responsive/") {
      res.end(PAGE(css(TOK), `${script(TOK, "responsive.js")}
        <div id="hidden-list" style="display:none"></div><div id="visible-list"></div>`));
    } else if (pathname === "/lazy/") {
      res.end(PAGE(css(TOK), `<script>globalThis.__lateAssetUrl=${JSON.stringify(assetUrl(TOK, "late.js"))}</script>${script(TOK, "lazy.js")}`));
    } else if (pathname === "/worker-socket/") {
      res.end(PAGE("", `<script>
        // Fires well after the page's stability hold and any single quiet interval: only a monitor
        // that holds its complete bounded grace still has this late evidence in the snapshot.
        const source = 'setTimeout(() => { new WebSocket("ws://127.0.0.1:54321/private"); new WebTransport("https://127.0.0.1:54321/private"); postMessage("started") }, 600)';
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        worker.onmessage = () => { document.body.dataset.workerStarted = "yes"; };
      </script>`));
    } else if (pathname === "/worker-benign/") {
      res.end(PAGE(css(TOK), script(TOK, "worker-app.js")));
    } else if (pathname === "/fetched/") {
      res.end(PAGE("", `<script>
        fetch(${JSON.stringify(assetUrl(TOK, "styles.css"))}).catch(() => {});
        fetch(${JSON.stringify(assetUrl(TOK, "app.js"))}).catch(() => {});
        ${APP_JS}
      </script>`));
    } else if (pathname === "/mixed/") {
      res.end(PAGE(css(TOK2), `${script(TOK, "app.js")}${script(TOK2, "app.js")}`));
    } else if (pathname === "/large/") {
      res.end(PAGE(css(TOK), `${script(TOK, "large.js")}${script(TOK, "app.js")}`));
    } else if (pathname === "/aggregate/") {
      res.end(PAGE(css(TOK), `${script(TOK, "part-a.js")}${script(TOK, "part-b.js")}`));
    } else if (pathname === "/redirect/page") {
      res.end(PAGE(css(TOK), script(TOK, "app.js")));
    } else if (pathname === "/bad/") {
      res.end(PAGE("", '<script>fetch("http://127.0.0.1:1/x"); new WebSocket("ws://example.com/x"); try { new RTCPeerConnection(); } catch {}</script><link rel="stylesheet" href="https://fonts.googleapis.com/css2?f=X">'));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await listen(preview);
  const base = `http://127.0.0.1:${preview.address().port}`;

  let judge;
  try {
    judge = await createBrowserJudge({
      assetsHost: assetHost,
      assetProtocol: "http:",
      maxAssetBodyBytes: 4_096,
      maxTotalAssetBytes: 5_000,
      navigationTimeoutMs: 3_000,
      witnessTimeoutMs: 500,
      stabilityWindowMs: 150,
      assetQuietWindowMs: 25,
      assetSettleTimeoutMs: 1_500,
    });
  } catch (error) {
    await Promise.all([close(preview), close(assets)]);
    throw error;
  }

  const inspect = (name, paths, options) => judge.inspect(
    `${base}/${name}/`,
    NS,
    { assetPaths: paths, assetCount: paths.length },
    options,
  );
  try {
    await t.test("successful classic and CORS-enabled module assets execute", async () => {
      for (const [name, js] of [["good", "app.js"], ["module", "module-cors.js"]]) {
        const snap = await inspect(name, ["styles.css", js]);
        assert.equal(browserOk(snap), true, `${name}: ${JSON.stringify(snap)}`);
        assert.equal(
          deployedAssetsOk(snap, { assetPaths: ["styles.css", js], assetCount: 2 }),
          true,
          `${name}: ${JSON.stringify({ ...snap, loadedAssets: [...snap.loadedAssets], assetTokens: [...snap.assetTokens] })}`,
        );
        assert.equal(currentAssetToken(snap), TOK);
        assert.equal(snap.loadedAssets.get("styles.css")?.digest, digest(CSS_TEXT));
        assert.equal(snap.loadedAssets.get(js)?.digest, digest(APP_JS));
      }
    });

    await t.test("routing does not grant CORS to a cross-origin module", async () => {
      const snap = await inspect("cors", ["styles.css", "module-no-cors.js"]);
      assert.equal(snap.apiOk, false);
      assert.equal(snap.witnessRendered, false);
      assert.equal(browserOk(snap), false);
      assert.equal(deployedAssetsOk(snap, { assetPaths: ["styles.css", "module-no-cors.js"], assetCount: 2 }), false);
    });

    await t.test("one working bundle cannot mask another bundle that never executed", async () => {
      const paths = ["styles.css", "app.js", "module-no-cors.js"];
      const snap = await inspect("partial", paths);
      assert.equal(snap.apiOk, true);
      assert.equal(snap.witnessRendered, true);
      assert.ok(snap.violations.some(v => v.kind === "cdn-load-failed"), JSON.stringify(snap.violations));
      assert.equal(browserOk(snap), false);
    });

    await t.test("a server-rendered row plus an ignored API response cannot satisfy the witness", async () => {
      const snap = await inspect("ssr", ["styles.css", "noop.js"]);
      assert.equal(snap.apiOk, true, "the fetch itself should still be observed");
      assert.equal(snap.witnessRendered, false, "the private response-only nonce was never rendered");
      assert.equal(browserOk(snap), false);
    });

    await t.test("a broken classic bundle cannot hide behind a working inline fallback", async () => {
      const meta = { assetPaths: ["styles.css", "broken.js"], assetCount: 2 };
      const snap = await inspect("broken", meta.assetPaths);
      assert.equal(snap.apiOk, false, "the surviving fetch came from inline code, not the broken asset");
      assert.equal(snap.witnessRendered, false, "an inline API caller is not authorized to receive the nonce");
      assert.ok(snap.pageErrors.length > 0, JSON.stringify(snap));
      assert.ok(snap.violations.some(v => v.kind === "script-not-executed"), JSON.stringify(snap.violations));
      assert.equal(browserOk(snap), false);
      assert.equal(deployedAssetsOk(snap, meta), false);
    });

    await t.test("sourceURL text cannot impersonate a canonical network script as the API caller", async () => {
      const meta = { assetPaths: ["styles.css", "idle.js"], assetCount: 2 };
      const snap = await inspect("sourceurl", meta.assetPaths);
      assert.equal(snap.apiOk, false, "inline eval must not inherit the URL it writes in a sourceURL comment");
      assert.equal(snap.witnessRendered, false);
      assert.equal(browserOk(snap), false);
      // The real idle.js did execute, so this specifically guards caller provenance rather than the
      // independent script-execution aggregate.
      assert.equal(deployedAssetsOk(snap, meta), true);
    });

    await t.test("a compressed canonical script may carry a real sourceURL comment", async () => {
      const meta = { assetPaths: ["styles.css", "sourceurl-app.js"], assetCount: 2 };
      const snap = await inspect("sourceurl-real", meta.assetPaths);
      assert.equal(browserOk(snap), true, JSON.stringify(snap));
      assert.equal(deployedAssetsOk(snap, meta), true);
    });

    await t.test("the rendered witness and page-error verdict survive a stability window", async () => {
      const snap = await inspect("transient", ["styles.css", "transient.js"]);
      assert.equal(snap.witnessRendered, false, "a nonce that disappears immediately is not a stable render");
      assert.ok(snap.pageErrors.includes("late failure"), JSON.stringify(snap.pageErrors));
      assert.equal(browserOk(snap), false);
    });

    await t.test("a hidden duplicate does not mask a later visible witness", async () => {
      const meta = { assetPaths: ["styles.css", "responsive.js"], assetCount: 2 };
      const snap = await inspect("responsive", meta.assetPaths);
      assert.equal(browserOk(snap), true, JSON.stringify(snap));
      assert.equal(deployedAssetsOk(snap, meta), true);
    });

    await t.test("a legitimate lazy canonical asset may finish inside the bounded settle window", async () => {
      const paths = ["styles.css", "lazy.js", "late.js"];
      const snap = await inspect("lazy", paths);
      assert.equal(browserOk(snap), true, JSON.stringify(snap));
      assert.ok(!snap.violations.some(v => v.kind === "asset-incomplete"), JSON.stringify(snap.violations));
      assert.equal(snap.loadedAssets.get("late.js")?.kind, "script");
    });

    await t.test("fetching CSS/JS bytes is not execution or application", async () => {
      const meta = { assetPaths: ["styles.css", "app.js"], assetCount: 2 };
      const snap = await inspect("fetched", meta.assetPaths);
      assert.equal(snap.witnessRendered, false, "an inline API caller is not authorized to receive the nonce");
      assert.equal(snap.apiOk, false, "the API caller was inline; downloaded JS never executed");
      assert.equal(browserOk(snap), false);
      assert.equal(deployedAssetsOk(snap, meta), false);
      assert.equal(snap.loadedAssets.size, 0);
    });

    await t.test("two tokens for the same manifest path fail instead of overwriting", async () => {
      const meta = { assetPaths: ["styles.css", "app.js"], assetCount: 2 };
      const snap = await inspect("mixed", meta.assetPaths);
      assert.deepEqual(new Set(snap.assetTokens), new Set([TOK, TOK2]));
      assert.equal(currentAssetToken(snap), null);
      assert.equal(deployedAssetsOk(snap, meta), false);
      assert.equal(rotatedAssetsOk(snap, meta, TOK), false);
      assert.ok(snap.violations.some(v => v.kind === "asset-version-conflict"), JSON.stringify(snap));
    });

    await t.test("oversize canonical bodies are not buffered into digest evidence", async () => {
      const paths = ["styles.css", "large.js", "app.js"];
      const snap = await inspect("large", paths);
      assert.ok(
        snap.violations.some(v => v.kind === "asset-oversize"),
        JSON.stringify({ ...snap, loadedAssets: [...snap.loadedAssets], assetTokens: [...snap.assetTokens] }),
      );
      assert.equal(snap.loadedAssets.has("large.js"), false);
      assert.equal(browserOk(snap), false);
    });

    await t.test("the aggregate streaming budget covers multiple individually valid assets", async () => {
      const paths = ["styles.css", "part-a.js", "part-b.js"];
      const snap = await inspect("aggregate", paths);
      assert.ok(snap.violations.some(v => v.kind === "asset-total-oversize"), JSON.stringify(snap.violations));
      assert.equal(browserOk(snap), false);
    });

    await t.test("an otherwise working same-origin redirect remains a scored violation", async () => {
      const paths = ["styles.css", "app.js"];
      const snap = await inspect("redirect", paths);
      assert.equal(snap.witnessRendered, true);
      assert.ok(snap.violations.some(v => v.kind === "redirect"), JSON.stringify(snap.violations));
      assert.equal(browserOk(snap), false);
    });

    await t.test("private targets and sockets violate; blocked public HTTPS remains neutral", async () => {
      const snap = await inspect("bad", [], { witness: false });
      assert.ok(snap.violations.some(v => v.kind === "private-target"), JSON.stringify(snap.violations));
      assert.ok(snap.violations.some(v => v.kind === "websocket"), JSON.stringify(snap.violations));
      assert.ok(snap.violations.some(v => v.kind === "blocked-transport"), JSON.stringify(snap.violations));
      assert.ok(snap.blockedExternal.some(url => url.includes("fonts.googleapis.com")));
      assert.ok(!snap.violations.some(v => v.url.includes("fonts.googleapis.com")));
    });

    await t.test("a dedicated worker cannot open a socket around Playwright routing", async () => {
      const snap = await inspect("worker-socket", [], { witness: false });
      assert.ok(snap.violations.some(v => v.kind === "worker-websocket"), JSON.stringify(snap.violations));
      assert.ok(snap.violations.some(v => v.kind === "worker-webtransport"), JSON.stringify(snap.violations));
    });

    await t.test("monitoring does not prevent an ordinary dedicated worker from running", async () => {
      const meta = { assetPaths: ["styles.css", "worker-app.js"], assetCount: 2 };
      const snap = await inspect("worker-benign", meta.assetPaths);
      assert.equal(browserOk(snap), true, JSON.stringify(snap));
      assert.equal(deployedAssetsOk(snap, meta), true);
    });
  } finally {
    await Promise.all([close(preview), close(assets), judge.close()]);
  }
});

test("boundary proxy tunnels allowed https authorities and refuses the rest", async () => {
  const { createBoundaryProxy } = await import("./browser-judge.mjs");
  // A local TCP endpoint standing in for an allowed https authority — CONNECT is protocol-blind.
  const upstream = net.createServer(socket => socket.end("tunneled"));
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;
  const blocked = [];
  const proxy = await createBoundaryProxy({
    allowedOrigins: [`https://127.0.0.1:${upstreamPort}`, "https://chat.example"],
    onBlocked: (kind, url) => blocked.push({ kind, url }),
  });
  const proxyPort = Number(new URL(proxy.url).port);
  const connect = (target) => new Promise((resolve) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = "";
    socket.on("data", d => { buf += d; if (buf.includes("\r\n\r\n")) { socket.end(); resolve(buf.split("\r\n")[0]); } });
    socket.on("error", () => resolve("error"));
    socket.on("close", () => resolve(buf.split("\r\n")[0] || "closed"));
  });

  try {
    // Explicit port matches an allowed authority with the same explicit port.
    assert.match(await connect(`127.0.0.1:${upstreamPort}`), /200/);
    // The regression this test pins: an allowed default-port authority must accept the
    // browser-style explicit :443 CONNECT instead of refusing every https tunnel.
    const kinds = blocked.length;
    assert.match(await connect("chat.example:443"), /^(?!.*403).*$/s);
    assert.equal(blocked.length, kinds, "allowed default-port tunnel must not be scored as blocked");
    // Unlisted authorities are refused and scored.
    assert.match(await connect("evil.example:443"), /403/);
    assert.ok(blocked.some(b => b.kind === "proxy-target" && b.url.includes("evil.example")));
  } finally {
    await proxy.close();
    await new Promise(r => upstream.close(r));
  }
});

test("an abruptly torn tunnel peer cannot crash the proxy process", async () => {
  const { createBoundaryProxy } = await import("./browser-judge.mjs");
  // The upstream keeps writing after the client vanishes: without an error sink on the client
  // socket, the piped EPIPE is an unhandled 'error' event and takes down the whole bench.
  const upstream = net.createServer(socket => {
    const timer = setInterval(() => socket.write("x".repeat(4096)), 5);
    socket.on("close", () => clearInterval(timer));
    socket.on("error", () => clearInterval(timer));
  });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;
  const proxy = await createBoundaryProxy({
    allowedOrigins: [`https://127.0.0.1:${upstreamPort}`],
    onBlocked: () => {},
  });
  const proxyPort = Number(new URL(proxy.url).port);
  try {
    await new Promise((resolve) => {
      const client = net.connect(proxyPort, "127.0.0.1", () => {
        client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
      client.once("data", () => {
        // Tunnel established and flowing — RST the connection (not a FIN: an orderly destroy tears
        // the pipe down through close events and never materializes the EPIPE) while the upstream
        // keeps writing into it.
        client.resetAndDestroy();
        setTimeout(resolve, 200);
      });
      client.on("error", () => {});
    });
    // Reaching this line at all is the assertion: the process survived the EPIPE window.
    assert.ok(true);
  } finally {
    await proxy.close();
    await new Promise(r => upstream.close(r));
  }
});

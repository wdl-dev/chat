// Real-browser judge for hard-task.mjs. Chromium, rather than a parser or a replayed Node fetch,
// answers the browser questions: did the page load under its real CORS/CSP rules, did its own
// fetch consume the API response, and which canonical assets actually executed or applied?
//
// Browser routing plus a process-wide allowlist proxy form the network boundary. Allowed requests
// continue untouched, so interception cannot accidentally grant CORS permission or alter response
// semantics. Canonical asset bodies are observed after Chromium receives them, with independent
// count/size caps, solely to compute deploy digests. The API witness is injected only into a
// successful same-origin fetch whose runtime caller is a canonical script from this artifact; it
// is never persisted, so a different request or server-rendered/stale data cannot impersonate
// consumption of that response.
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { deployedAssetRef, isPrivateHost } from "./hard-task-logic.mjs";

const urlKey = (href) => {
  try {
    const u = new URL(href);
    u.hash = "";
    return u.href;
  } catch { return String(href); }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validateInteger = (name, value, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
};

// Playwright's HTTP/WebSocket routing covers page requests, but Chromium does not surface sockets
// opened by dedicated/shared workers through routeWebSocket. Put each browser behind a real proxy
// as the transport-level backstop: only the preview and canonical asset authorities may receive a
// TCP tunnel. HTTP responses and HTTPS tunnels otherwise pass through byte-for-byte, so this layer
// does not grant CORS or rewrite browser semantics. The route layer below remains the finer-grained
// path/method policy and supplies neutral handling for ordinary blocked public resources.
export async function createBoundaryProxy({ allowedOrigins, onBlocked }) {
  const allowed = new Set(allowedOrigins.map(String));
  // CONNECT targets always carry an explicit port while URL.host omits a default one — compare
  // hostname:port with the default filled in on both sides, or every https tunnel is refused.
  const tunnelKey = (hostname, port) => `${hostname}:${port || "443"}`;
  const allowedTunnels = new Set([...allowed].filter(origin => origin.startsWith("https:"))
    .map(origin => { const u = new URL(origin); return tunnelKey(u.hostname, u.port); }));
  const sockets = new Set();
  // Every stream the proxy touches gets an error sink: a peer that disappears mid-pipe emits
  // EPIPE/ECONNRESET on the counterpart, and one unhandled 'error' event kills the whole bench
  // process. Swallow and destroy — the boundary has nothing to recover, only to shut the pair.
  const guard = stream => {
    stream.on("error", () => stream.destroy());
    return stream;
  };
  const track = socket => {
    guard(socket);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const cleanHeaders = (headers, host) => {
    const out = { ...headers, host };
    delete out["proxy-authorization"];
    delete out["proxy-connection"];
    return out;
  };
  const rejectSocket = (socket, status = "403 Forbidden") => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const server = http.createServer((req, res) => {
    guard(req);
    guard(res);
    let target;
    try { target = new URL(req.url); } catch {
      onBlocked("proxy-unparsable", String(req.url));
      res.writeHead(400).end();
      return;
    }
    if (!allowed.has(target.origin) || !new Set(["http:", "https:"]).has(target.protocol)) {
      onBlocked("proxy-target", target.href);
      res.writeHead(403).end();
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(target, {
      method: req.method,
      headers: cleanHeaders(req.headers, target.host),
      // Node's Happy-Eyeballs default is unreliable where IPv6 is broken: dual-stack CDN connects
      // fail with an empty AggregateError while v4-first order succeeds. Follow the system
      // resolver order, as curl does, instead of racing address families.
      autoSelectFamily: false,
    }, upstreamResponse => {
      guard(upstreamResponse);
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    track(upstream);
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("connect", (req, client, head) => {
    track(client);
    let target;
    try { target = new URL(`http://${req.url}`); } catch {
      onBlocked("proxy-unparsable", String(req.url));
      rejectSocket(client, "400 Bad Request");
      return;
    }
    if (!allowedTunnels.has(tunnelKey(target.hostname, target.port))) {
      onBlocked("proxy-target", `https://${target.host}/`);
      rejectSocket(client);
      return;
    }
    const port = Number(target.port || 443);
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const upstream = track(net.connect({ host: hostname, port, autoSelectFamily: false }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    }));
    upstream.on("error", () => rejectSocket(client, "502 Bad Gateway"));
  });
  server.on("upgrade", (req, socket) => {
    track(socket);
    onBlocked("websocket", String(req.url));
    rejectSocket(socket);
  });
  server.on("clientError", (_error, socket) => rejectSocket(socket, "400 Bad Request"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function createBrowserJudge({
  assetsHost = "assets.wdl.dev",
  assetProtocol = "https:",
  fixedWorkerName = "app",
  maxAssetBodyBytes = 5_000_000,
  maxTotalAssetBytes = 10_000_000,
  maxApiBodyBytes = 1_000_000,
  maxRequests = 128,
  maxAssets = 64,
  maxDiagnostics = 32,
  navigationTimeoutMs = 20_000,
  witnessTimeoutMs = 10_000,
  stabilityWindowMs = 750,
  assetQuietWindowMs = 100,
  assetSettleTimeoutMs = 5_000,
} = {}) {
  if (!new Set(["http:", "https:"]).has(assetProtocol)) {
    throw new Error(`invalid asset protocol: ${assetProtocol}`);
  }
  for (const [name, value] of Object.entries({
    maxAssetBodyBytes, maxTotalAssetBytes, maxApiBodyBytes, maxRequests, maxAssets, maxDiagnostics,
  })) validateInteger(name, value, 1);
  for (const [name, value] of Object.entries({ navigationTimeoutMs, witnessTimeoutMs })) {
    validateInteger(name, value, 1, 2_147_483_647);
  }
  for (const [name, value] of Object.entries({
    stabilityWindowMs, assetQuietWindowMs, assetSettleTimeoutMs,
  })) validateInteger(name, value, 0, 2_147_483_647);
  const normalizedAssetsHost = new URL(`${assetProtocol}//${assetsHost}`).host;
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("browser judge needs playwright: npm i -D playwright && npx playwright install chromium");
  }
  // Fail before a live benchmark spends a model turn. executablePath() alone is insufficient: a
  // downloaded binary can still be unlaunchable because its host libraries are missing.
  let preflightBrowser;
  try {
    preflightBrowser = await chromium.launch({ headless: true, args: ["--disable-quic"] });
  } catch (cause) {
    throw new Error(
      "browser judge cannot launch Chromium: run npx playwright install --with-deps chromium",
      { cause },
    );
  }
  await preflightBrowser.close().catch(() => {});
  const activeBrowsers = new Set();

  async function inspect(pageUrl, ns, artifactMeta, { witness = true } = {}) {
    const pageTarget = new URL(pageUrl);
    const origin = pageTarget.origin;
    const apiPath = pageTarget.pathname.replace(/\/?$/, "/") + "api/todos";
    const assetPaths = new Set(
      Array.isArray(artifactMeta?.assetPaths)
        ? artifactMeta.assetPaths.map(p => String(p).replace(/^\/+/, ""))
        : [],
    );
    const witnessTitle = witness ? `见证-${randomUUID()}` : null;
    const witnessId = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16) || 1;
    const assetConfig = {
      assetsHost: normalizedAssetsHost,
      assetProtocol,
      fixedWorkerName,
    };
    const assetObservations = [];
    const assetTokens = new Set();
    const violations = [];
    const violationKeys = new Set();
    const blockedExternal = [];
    const pageErrors = [];
    const consoleErrors = [];
    const streamTasks = new Set();
    const assetStreams = new Map();
    const scriptResponseDigests = new Map();
    const parsedScripts = new Map();
    const routedApiMarkers = new Set();
    const apiInitiators = new Map();
    const markerHeader = `x-wdl-bench-${randomUUID().replaceAll("-", "")}`;
    const markerPrefix = randomUUID().replaceAll("-", "");
    let apiOk = false;
    let requestCount = 0;
    let assetCount = 0;
    let totalAssetBytes = 0;
    let lastAssetActivity = 0;

    const pushDiagnostic = (list, value) => {
      if (list.length < maxDiagnostics) list.push(value);
    };
    const violate = (kind, url, detail) => {
      const key = `${kind}\0${url}\0${detail ?? ""}`;
      if (violationKeys.has(key) || violations.length >= maxDiagnostics) return;
      violationKeys.add(key);
      violations.push(detail === undefined ? { kind, url } : { kind, url, detail });
    };
    const trustedScript = script => script !== undefined
      && scriptResponseDigests.get(script.url)?.has(script.hash) === true;

    const boundary = await createBoundaryProxy({
      allowedOrigins: [origin, `${assetProtocol}//${normalizedAssetsHost}`],
      onBlocked: (kind, url) => violate(kind, url),
    });
    let browser = null;
    let context = null;
    try {
      // The proxy must be process-wide: Chromium does not consistently apply context proxy settings
      // to dedicated/shared Worker sockets. A browser per inspection also provides a genuinely
      // empty cache and credential store. `<-loopback>` removes Chromium's implicit localhost
      // bypass, keeping local services under the same boundary as production hosts.
      browser = await chromium.launch({
        headless: true,
        // WebTransport uses QUIC and does not traverse an HTTP proxy. Worker targets are monitored
        // below so attempts remain scored evidence; disabling QUIC supplies the enforcement half.
        args: ["--disable-quic"],
        proxy: { server: boundary.url, bypass: "<-loopback>" },
      });
      activeBrowsers.add(browser);
      context = await browser.newContext({ serviceWorkers: "block" });
      const authorizeBinding = `__wdlBenchAuthorize_${randomUUID().replaceAll("-", "")}`;
      const transportBinding = `__wdlBenchTransport_${randomUUID().replaceAll("-", "")}`;
      await context.exposeBinding(authorizeBinding, (_source, rawMarker) => {
        const marker = typeof rawMarker === "string" && rawMarker.length < 200 ? rawMarker : "";
        const initiators = apiInitiators.get(marker);
        const authorized = routedApiMarkers.has(marker) && initiators instanceof Set
          && [...initiators].some(scriptId => trustedScript(parsedScripts.get(scriptId)));
        routedApiMarkers.delete(marker);
        apiInitiators.delete(marker);
        if (authorized) apiOk = true;
        return authorized;
      });
      await context.exposeBinding(transportBinding, (_source, rawKind) => {
        const kind = new Set(["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport", "WebSocketStream"])
          .has(rawKind) ? rawKind : "unknown";
        violate("blocked-transport", "browser-transport:", kind);
      });
      await context.addInitScript(
        ({ apiPath: expectedPath, authorizeBinding: binding, transportBinding: transport, witnessTitle: title, witnessId: id, maxApiBodyBytes: maxBytes, markerHeader: headerName, markerPrefix: prefix }) => {
          const reportTransport = globalThis[transport].bind(globalThis);
          for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport", "WebSocketStream"]) {
            if (typeof globalThis[name] !== "function") continue;
            try {
              Object.defineProperty(globalThis, name, {
                configurable: true,
                writable: true,
                value: class {
                  constructor() {
                    void reportTransport(name).catch(() => {});
                    throw new Error(`${name} blocked by bench`);
                  }
                },
              });
            } catch {
              // Fail closed if a future browser makes one of these globals non-overridable.
              void reportTransport(name).catch(() => {});
            }
          }
          if (!title) return;

          const nativeFetch = window.fetch.bind(window);
          const NativeHeaders = window.Headers;
          const NativeRequest = window.Request;
          const NativeResponse = window.Response;
          const NativeTextDecoder = window.TextDecoder;
          const NativeURL = window.URL;
          const authorizeFetch = globalThis[binding].bind(globalThis);
          let markerSeq = 0;
          window.fetch = async (...args) => {
            const input = args[0];
            const init = args[1];
            const method = String(init?.method ?? (input instanceof NativeRequest ? input.method : "GET")).toUpperCase();
            let target = null;
            try { target = new NativeURL(input instanceof NativeRequest ? input.url : String(input), location.href); } catch { /* native fetch owns the error */ }

            const candidate = method === "GET" && target?.origin === location.origin
              && target.pathname === expectedPath;
            let marker = null;
            let fetchArgs = args;
            if (candidate) {
              marker = `${prefix}.${++markerSeq}`;
              // Candidate requests are GETs, so rebuilding only their headers cannot consume a
              // streaming body. The route handler strips this correlation header before it reaches
              // the generated Worker; CDP sees it early enough to bind the network request to its
              // unforgeable initiator scriptIds.
              const headers = new NativeHeaders(
                init?.headers ?? (input instanceof NativeRequest ? input.headers : undefined),
              );
              headers.set(headerName, marker);
              fetchArgs = [input, { ...init, headers }];
            }

            const response = await nativeFetch(...fetchArgs);
            if (!candidate || !response.ok) return response;
            let authorized = false;
            try { authorized = await authorizeFetch(marker) === true; } catch { /* fail closed */ }
            if (!authorized) return response;

            // Bound the cloned stream while reading it. The original response remains untouched if
            // it is too large, malformed, or not the promised { todos: [...] } representation.
            try {
              const declared = Number(response.headers.get("content-length"));
              if (Number.isFinite(declared) && declared > maxBytes) return response;
              const reader = response.clone().body?.getReader();
              if (!reader) return response;
              const chunks = [];
              let total = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > maxBytes) {
                  await reader.cancel().catch(() => {});
                  return response;
                }
                chunks.push(value);
              }
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
              const data = JSON.parse(new NativeTextDecoder().decode(bytes));
              if (!Array.isArray(data?.todos)) return response;
              data.todos = [{ id, title, done: false }, ...data.todos];
              const headers = new NativeHeaders(response.headers);
              headers.delete("content-encoding");
              headers.delete("content-length");
              headers.set("content-type", "application/json; charset=utf-8");
              const injected = new NativeResponse(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers,
              });
              // Synthetic Response normally loses these network-derived readonly fields. Shadow
              // them so ordinary client guards see the same response identity/redirect facts.
              for (const key of ["url", "redirected", "type"]) {
                try { Object.defineProperty(injected, key, { value: response[key] }); } catch { /* cosmetic */ }
              }
              return injected;
            } catch {
              return response;
            }
          };
        },
        {
          apiPath, authorizeBinding, transportBinding, witnessTitle, witnessId, maxApiBodyBytes,
          markerHeader, markerPrefix,
        },
      );
      if (typeof context.routeWebSocket !== "function") {
        throw new Error("browser judge needs Playwright routeWebSocket support");
      }
      await context.routeWebSocket("**/*", ws => {
        violate("websocket", ws.url());
        ws.close();
      });
      await context.route("**/*", async (route) => {
        const req = route.request();
        const url = req.url();
        requestCount += 1;
        if (requestCount > maxRequests) {
          violate("request-limit", url, maxRequests);
          return route.abort();
        }

        let target;
        try { target = new URL(url); } catch {
          violate("unparsable", url);
          return route.abort();
        }
        const isPreview = target.origin === origin;
        const isAssetOrigin = target.host === normalizedAssetsHost && target.protocol === assetProtocol;
        const deployed = deployedAssetRef(url, ns, assetPaths, assetConfig);
        const rawMarker = req.headers()[markerHeader];
        const marker = typeof rawMarker === "string" && rawMarker.startsWith(`${markerPrefix}.`)
          ? rawMarker : null;

        if (isAssetOrigin && !isPreview && deployed === null) {
          // A CDN request for another namespace/worker, a non-manifest path, or a non-canonical URL
          // is not part of this deployment and must not be fetched.
          violate("cdn-not-owned", url);
          return route.abort();
        }
        if (!isPreview && !isAssetOrigin) {
          if (target.protocol === "https:" && !isPrivateHost(target.hostname)) {
            pushDiagnostic(blockedExternal, url); // fonts etc: neutral; page must work without them
          } else {
            violate(isPrivateHost(target.hostname) ? "private-target" : "cleartext-or-scheme", url);
          }
          return route.abort();
        }
        if (deployed !== null && req.method() !== "GET") {
          violate("cdn-method", url, req.method());
          return route.abort();
        }
        if (deployed !== null && ++assetCount > maxAssets) {
          violate("asset-count-limit", url, maxAssets);
          return route.abort();
        }
        // Deliberately do not route.fetch/fulfill here. Continuing lets Chromium apply the actual
        // CORS, CSP, redirect, MIME, module, and cache semantics of the served response. The one
        // synthetic correlation header is removed before the generated Worker sees the request.
        if (marker !== null) {
          if (isPreview && req.method() === "GET" && target.pathname === apiPath) {
            routedApiMarkers.add(marker);
          }
          const headers = await req.allHeaders();
          delete headers[markerHeader];
          return route.continue({ headers });
        }
        return route.continue();
      });

      const page = await context.newPage();
      page.on("pageerror", err => pushDiagnostic(pageErrors, String(err?.message ?? err).slice(0, 300)));
      page.on("console", msg => {
        if (msg.type() === "error") pushDiagnostic(consoleErrors, msg.text().slice(0, 300));
      });

      // CDP can mirror response chunks without taking ownership of the response. That gives the
      // digest side a real streaming cap while the renderer continues to receive the original
      // bytes. In particular, a chunked asset never goes through Playwright Response.body().
      const cdp = await context.newCDPSession(page);
      const styleSheetUrls = new Map();
      let workerCommandId = 0;
      const sendWorkerCommand = (sessionId, method, params = {}) => cdp.send(
        "Target.sendMessageToTarget",
        { sessionId, message: JSON.stringify({ id: ++workerCommandId, method, params }) },
      );
      const workerSessions = new Set();
      const workerArmTasks = new Set();
      const workerReplies = new Map();
      // cdp.send only awaits the browser's ack of sendMessageToTarget; a real barrier must wait
      // for the worker's inner reply, which travels the same ordered per-session channel as its
      // events — so when the reply arrives, everything the worker emitted before it already has.
      const workerRoundTrip = (sessionId) => new Promise((resolve) => {
        const id = ++workerCommandId;
        workerReplies.set(id, resolve);
        setTimeout(() => { if (workerReplies.delete(id)) resolve(); }, 1_000).unref?.();
        cdp.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "0", returnByValue: true } }),
        }).catch(() => { if (workerReplies.delete(id)) resolve(); });
      });
      const armWorkerTarget = async ({ sessionId, targetInfo }) => {
        workerSessions.add(sessionId);
        try {
          // The target is paused before its first instruction. Enable both domains before resume so
          // an immediate constructor call or uncaught exception cannot race the monitor.
          await sendWorkerCommand(sessionId, "Network.enable");
          await sendWorkerCommand(sessionId, "Runtime.enable");
        } catch (error) {
          violate("worker-monitor", targetInfo?.url ?? "worker:", String(error?.message ?? error).slice(0, 120));
        } finally {
          await sendWorkerCommand(sessionId, "Runtime.runIfWaitingForDebugger").catch(error => {
            violate("worker-monitor", targetInfo?.url ?? "worker:", String(error?.message ?? error).slice(0, 120));
          });
        }
      };
      cdp.on("Target.attachedToTarget", event => {
        const task = armWorkerTarget(event);
        workerArmTasks.add(task);
        void task.finally(() => workerArmTasks.delete(task));
      });
      cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
        let event;
        try { event = JSON.parse(message); } catch { return; }
        if (typeof event?.id === "number") {
          const resolve = workerReplies.get(event.id);
          if (resolve) { workerReplies.delete(event.id); resolve(); }
          return;
        }
        const params = event?.params ?? {};
        if (event?.method === "Network.webSocketCreated") {
          violate("worker-websocket", String(params.url ?? "worker-websocket:"));
        } else if (event?.method === "Network.webTransportCreated") {
          violate("worker-webtransport", String(params.url ?? "worker-webtransport:"));
        } else if (event?.method === "Network.directTCPSocketCreated") {
          violate("worker-direct-socket", `tcp://${params.remoteAddr ?? "unknown"}:${params.remotePort ?? 0}`);
        } else if (event?.method === "Network.directUDPSocketCreated") {
          const options = params.options ?? {};
          violate("worker-direct-socket", `udp://${options.remoteAddr ?? "unknown"}:${options.remotePort ?? 0}`);
        } else if (event?.method === "Runtime.exceptionThrown") {
          const detail = params.exceptionDetails ?? {};
          pushDiagnostic(pageErrors, `worker: ${detail.exception?.description ?? detail.text ?? "uncaught exception"}`.slice(0, 300));
        } else if (event?.method === "Runtime.consoleAPICalled" && params.type === "error") {
          const detail = (params.args ?? []).map(arg => arg.value ?? arg.description ?? "").join(" ");
          pushDiagnostic(consoleErrors, `worker: ${detail}`.slice(0, 300));
        }
      });
      cdp.on("Debugger.scriptParsed", (event) => {
        // A sourceURL comment controls event.url, but not the embedder name supplied by Chromium
        // for a network script. Prefer that network identity when present; an inline eval with a
        // forged canonical sourceURL has no canonical embedder and is therefore not recorded.
        const embeddedUrl = typeof event.embedderName === "string" ? event.embedderName : "";
        const embedded = deployedAssetRef(embeddedUrl, ns, assetPaths, assetConfig);
        const parsed = deployedAssetRef(event.url, ns, assetPaths, assetConfig);
        const networkUrl = embedded !== null
          ? urlKey(embeddedUrl)
          : event.hasSourceURL === true || parsed === null ? null : urlKey(event.url);
        if (networkUrl === null || typeof event.hash !== "string") return;
        parsedScripts.set(event.scriptId, {
          url: networkUrl,
          hash: event.hash.toLowerCase(),
        });
      });
      cdp.on("CSS.styleSheetAdded", ({ header }) => {
        if (header.sourceURL
          && deployedAssetRef(header.sourceURL, ns, assetPaths, assetConfig) !== null) {
          styleSheetUrls.set(header.styleSheetId, urlKey(header.sourceURL));
        }
      });
      await Promise.all([
        cdp.send("Network.enable", {
          maxResourceBufferSize: maxAssetBodyBytes,
          maxTotalBufferSize: maxTotalAssetBytes,
        }),
        cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: false,
          filter: [{ type: "worker" }, { type: "shared_worker" }, { exclude: true }],
        }),
        cdp.send("Debugger.enable"),
        cdp.send("DOM.enable").then(() => cdp.send("CSS.enable"))
          .then(() => cdp.send("CSS.startRuleUsageTracking")),
        cdp.send("Profiler.enable").then(() => cdp.send("Profiler.startPreciseCoverage", {
          callCount: true,
          detailed: true,
        })),
      ]);
      const finishAsset = (state) => {
        if (state.finalized || !state.finished || !state.streamReady || !state.responseSeen) return;
        state.finalized = true;
        assetStreams.delete(state.requestId);
        lastAssetActivity = Date.now();
        if (!state.failed && !state.ignored) {
          const digest = state.hash.digest("hex");
          assetObservations.push({
            path: state.path,
            token: state.token,
            url: state.url,
            resourceType: state.resourceType,
            digest,
          });
          if (state.resourceType === "script") {
            const digests = scriptResponseDigests.get(state.url) ?? new Set();
            digests.add(digest);
            scriptResponseDigests.set(state.url, digests);
          }
        }
      };
      const consumeChunk = (state, encoded) => {
        if (state.failed || typeof encoded !== "string" || encoded === "") return;
        const chunk = Buffer.from(encoded, "base64");
        state.bytes += chunk.length;
        totalAssetBytes += chunk.length;
        if (state.bytes > maxAssetBodyBytes) {
          state.failed = true;
          violate("asset-oversize", state.url, state.bytes);
          return;
        }
        if (totalAssetBytes > maxTotalAssetBytes) {
          state.failed = true;
          violate("asset-total-oversize", state.url, maxTotalAssetBytes);
          return;
        }
        state.hash.update(chunk);
      };
      cdp.on("Network.requestWillBeSent", (event) => {
        const { requestId, request, type, initiator } = event;
        const url = request.url;
        const requestMarker = Object.entries(request.headers ?? {})
          .find(([name]) => name.toLowerCase() === markerHeader)?.[1];
        if (typeof requestMarker === "string" && requestMarker.startsWith(`${markerPrefix}.`)) {
          let target = null;
          try { target = new URL(url); } catch { /* route handles malformed URLs */ }
          if (request.method === "GET" && target?.origin === origin && target.pathname === apiPath) {
            const scriptIds = new Set();
            let stack = initiator?.stack;
            while (stack) {
              for (const frame of stack.callFrames ?? []) {
                if (typeof frame.scriptId === "string") scriptIds.add(frame.scriptId);
              }
              stack = stack.parent;
            }
            apiInitiators.set(requestMarker, scriptIds);
          }
        }
        const deployed = deployedAssetRef(url, ns, assetPaths, assetConfig);
        if (deployed === null || request.method !== "GET") return;
        // Programmatic fetch/xhr of a manifest URL is API traffic, not evidence that the browser
        // loaded that URL as a page resource.
        const resourceType = String(type).toLowerCase();
        if (resourceType === "fetch" || resourceType === "xhr") return;
        lastAssetActivity = Date.now();
        const state = {
          requestId,
          ...deployed,
          url: urlKey(url),
          resourceType,
          hash: createHash("sha256"),
          bytes: 0,
          failed: false,
          finished: false,
          streamReady: false,
          responseSeen: false,
          ignored: false,
          finalized: false,
        };
        assetStreams.set(requestId, state);
        const task = cdp.send("Network.streamResourceContent", { requestId }).then(
          ({ bufferedData }) => {
            consumeChunk(state, bufferedData);
            state.streamReady = true;
            finishAsset(state);
          },
          error => {
            state.failed = true;
            state.streamReady = true;
            violate("asset-stream", url, String(error?.message ?? error).slice(0, 120));
            finishAsset(state);
          },
        );
        streamTasks.add(task);
        task.finally(() => streamTasks.delete(task));
      });
      cdp.on("Network.responseReceived", (event) => {
        const state = assetStreams.get(event.requestId);
        if (state === undefined) return;
        state.responseSeen = true;
        state.resourceType = String(event.type).toLowerCase();
        if (state.resourceType === "fetch" || state.resourceType === "xhr") {
          state.ignored = true;
          finishAsset(state);
          return;
        }
        if (event.response.status < 200 || event.response.status >= 300) {
          state.failed = true;
          violate("cdn-load-failed", state.url, event.response.status);
        } else {
          assetTokens.add(state.token);
        }
        const contentLength = Object.entries(event.response.headers ?? {})
          .find(([name]) => name.toLowerCase() === "content-length")?.[1];
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > maxAssetBodyBytes) {
          state.failed = true;
          violate("asset-oversize", state.url, declared);
        }
        finishAsset(state);
      });
      cdp.on("Network.dataReceived", (event) => {
        const state = assetStreams.get(event.requestId);
        if (state !== undefined) consumeChunk(state, event.data);
      });
      cdp.on("Network.loadingFinished", (event) => {
        const state = assetStreams.get(event.requestId);
        if (state === undefined) return;
        state.finished = true;
        finishAsset(state);
      });
      cdp.on("Network.loadingFailed", (event) => {
        const state = assetStreams.get(event.requestId);
        if (state === undefined) return;
        state.failed = true;
        state.finished = true;
        state.responseSeen = true;
        violate("cdn-load-failed", state.url, event.errorText);
        finishAsset(state);
      });

      page.on("response", (response) => {
        const url = response.url();
        const status = response.status();
        if (status >= 300 && status < 400) violate("redirect", url, status);
      });

      let pageOk = false;
      try {
        const nav = await page.goto(pageUrl, { waitUntil: "load", timeout: navigationTimeoutMs });
        pageOk = nav !== null && nav.ok()
          && String(nav.headers()["content-type"] ?? "").toLowerCase().includes("text/html");
      } catch { pageOk = false; }

      let witnessRendered = false;
      let visibleWitness = null;
      if (pageOk && witnessTitle !== null) {
        try {
          // A visible-text locator is browser evidence and also pierces open shadow roots; scanning
          // document.body.innerText would reject an otherwise visible web-component UI. Filter
          // before first(): responsive layouts commonly place a hidden copy before the visible one.
          visibleWitness = page.getByText(witnessTitle, { exact: false }).filter({ visible: true });
          await visibleWitness.first()
            .waitFor({ state: "visible", timeout: witnessTimeoutMs });
          witnessRendered = true;
        } catch { witnessRendered = false; }
      }

      // First paint is not the verdict. Hold a bounded stability window, and within it wait for the
      // canonical-asset stream set to become quiet. This catches immediate post-render failures and
      // lets legitimate lazy chunks finish without turning an arbitrary CDP scheduling race into an
      // asset-incomplete failure. Polling is intentional: CDP events mutate the state asynchronously.
      if (pageOk) {
        const started = Date.now();
        const stableAt = started + Math.max(0, stabilityWindowMs);
        const deadline = started + Math.max(stabilityWindowMs, assetSettleTimeoutMs, 0);
        while (true) {
          const now = Date.now();
          const assetsQuiet = assetStreams.size === 0
            && (lastAssetActivity === 0 || now - lastAssetActivity >= assetQuietWindowMs);
          if (now >= stableAt && assetsQuiet) break;
          if (now >= deadline) break;
          await delay(Math.min(25, Math.max(1, deadline - now)));
        }
      }

      const [{ result: jsCoverage }, { ruleUsage }] = await Promise.all([
        cdp.send("Profiler.takePreciseCoverage").catch(() => ({ result: [] })),
        cdp.send("CSS.stopRuleUsageTracking").catch(() => ({ ruleUsage: [] })),
      ]);
      await cdp.send("Profiler.stopPreciseCoverage").catch(() => {});
      while (streamTasks.size > 0) await Promise.all([...streamTasks]);
      // An attached target starts paused and its arming callback is async: a round-trip issued
      // before the arm finishes can queue ahead of runIfWaitingForDebugger, get answered by a
      // worker that has not run its first instruction, and close the snapshot too early. Every
      // observed arm must finish posting enable + resume before its session is asked to round-trip.
      while (workerArmTasks.size > 0) await Promise.all([...workerArmTasks]);
      await Promise.all([...workerSessions].map(workerRoundTrip));
      // The round-trip orders only worker-renderer events. Network.* events for worker sockets are
      // emitted by the network service on another process, with no ordered channel to wait on,
      // and a quiet interval is not a completion signal — under load the proxy observes a socket
      // before CDP reports it, so an early exit truncates the snapshot. Worker pages pay one full
      // bounded grace period; pages without workers pay nothing.
      if (workerSessions.size > 0) {
        await delay(750);
      }
      for (const state of assetStreams.values()) {
        state.failed = true;
        state.finished = true;
        state.responseSeen = true;
        state.streamReady = true;
        violate("asset-incomplete", state.url);
        finishAsset(state);
      }
      if (witnessRendered && visibleWitness !== null) {
        try { witnessRendered = await visibleWitness.count() > 0; }
        catch { witnessRendered = false; }
      }

      const usedScripts = new Set(jsCoverage.filter(entry => entry.functions?.some(fn =>
        fn.ranges?.some(range => range.count > 0 && range.endOffset > range.startOffset)))
        .map(entry => parsedScripts.get(entry.scriptId))
        .filter(trustedScript)
        .map(script => script.url));
      const usedStyles = new Set(ruleUsage.filter(rule => rule.used)
        .map(rule => styleSheetUrls.get(rule.styleSheetId)).filter(Boolean));
      const loadedAssets = new Map();
      for (const observation of assetObservations) {
        if (observation.resourceType === "script" && !usedScripts.has(observation.url)) {
          violate("script-not-executed", observation.url, observation.path);
        }
        const kind = observation.resourceType === "script" && usedScripts.has(observation.url)
          ? "script"
          : observation.resourceType === "stylesheet" && usedStyles.has(observation.url)
            ? "style"
            : "other";
        const record = {
          token: observation.token,
          kind,
          digest: observation.digest,
        };
        const previous = loadedAssets.get(observation.path);
        if (previous && (previous.token !== record.token || previous.digest !== record.digest)) {
          violate("asset-version-conflict", observation.url, observation.path);
          continue;
        }
        if (!previous || (previous.kind === "other" && kind !== "other")) {
          loadedAssets.set(observation.path, record);
        }
      }

      return {
        pageOk,
        apiOk,
        witnessRendered,
        loadedAssets,
        assetTokens,
        violations,
        blockedExternal,
        pageErrors,
        consoleErrors,
      };
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      activeBrowsers.delete(browser);
      await boundary.close().catch(() => {});
    }
  }

  return {
    inspect,
    close: async () => {
      await Promise.all([...activeBrowsers].map(browser => browser.close().catch(() => {})));
      activeBrowsers.clear();
    },
  };
}

#!/usr/bin/env node
// Wrangler shim for the sandbox pack path (pointed at by WDL_WRANGLER_BIN).
//
// wrangler 4.100's autoconfig opens keep-alive connections to Cloudflare that,
// from the restricted sandbox egress, sometimes don't close — so the process
// lingers for tens of seconds AFTER the `--dry-run` bundle is already written
// to --outdir. The CLI packs synchronously (execFileSync waits for wrangler to
// exit), so that linger stalls every deploy and intermittently trips the 60s
// pack timeout. Once wrangler reports the dry-run bundle is done, force-exit
// instead of waiting for those sockets; --outdir is complete by then, so the
// caller still reads a full manifest. Anything else (fast exit, real error)
// passes through unchanged.

import { spawn } from "node:child_process";

const realWrangler =
  `${process.env.WDL_CLI_LOCAL_PATH || "/opt/wdl-cli"}/node_modules/.bin/wrangler`;
const DONE_MARKER = "dry-run: exiting now";

const child = spawn(realWrangler, process.argv.slice(2), {
  stdio: ["inherit", "pipe", "pipe"],
});

let settled = false;
function settle(code) {
  if (settled) return;
  settled = true;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  process.exit(code);
}

// Forward wrangler's stdout/stderr verbatim — the caller (packWranglerProject)
// runs us via execFileSync and parses our stdout (e.g. `wrangler --version`),
// so swallowing it breaks the pre-pack version check. The caller captures this
// output; it never reaches pack.js's own manifest stdout. Scan both streams
// for the bundle-done marker.
child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
  if (buf.toString("utf8").includes(DONE_MARKER)) settle(0);
});
child.stderr.on("data", (buf) => {
  process.stderr.write(buf);
  if (buf.toString("utf8").includes(DONE_MARKER)) settle(0);
});
child.on("exit", (code) => settle(code ?? 0));
child.on("error", (err) => {
  process.stderr.write(`wrangler-shim: ${err?.message ?? err}\n`);
  settle(1);
});

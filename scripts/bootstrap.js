#!/usr/bin/env node
// Tenant bootstrap: ensure chat-db (migrations, via your demo-ns token store) and store the
// delegated token-issuer credential as TOKEN_ISSUER_TOKEN — no ops token. --mint-issuer mints
// one instead (operator; needs ADMIN_URL + BOOTSTRAP_TOKEN). See --help.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISSUE_TEMPLATE = "wdl-chat-ns-pool";

function die(msg) {
  process.stderr.write(`bootstrap: ${msg}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    "skip-d1":     { type: "boolean", default: false },
    "skip-issuer": { type: "boolean", default: false },
    "mint-issuer": { type: "boolean", default: false },
    help:          { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
`Usage: node scripts/bootstrap.js [options]

  --skip-d1       skip chat-db ensure + migrations
  --skip-issuer   skip storing the token-issuer credential
  --mint-issuer   (operator only) mint a fresh token-issuer via an ops token instead of
                  storing a provided TOKEN_ISSUER_TOKEN
  -h, --help

Env:
  TOKEN_ISSUER_TOKEN  the delegated token-issuer credential to store (default path)
  ADMIN_URL           control plane, e.g. https://api.wdl.dev (only with --mint-issuer)
  BOOTSTRAP_TOKEN     ops token (only with --mint-issuer)

D1 + secret operations use your wdl token store for --ns demo (run \`wdl token\` first) —
the same per-ns credential \`wdl deploy --ns demo\` uses. No ops token for the default path.
`);
  process.exit(0);
}

// d1 / secret go through the wdl token store for --ns demo, exactly like `wdl deploy`.
function wdl(args, opts = {}) {
  return execFileSync("wdl", args, { encoding: "utf8", ...opts });
}

function ensureChatDb() {
  if (values["skip-d1"]) {
    process.stderr.write("[skip-d1] not touching chat-db\n");
    return;
  }
  const listed = JSON.parse(wdl(["d1", "list", "--ns", "demo", "--json"]));
  const databases = Array.isArray(listed) ? listed : (listed?.databases ?? []);
  const entry = databases.find(d => d.databaseName === "chat-db");
  if (entry) {
    process.stderr.write(`chat-db already exists (${entry.databaseId}); skipping create\n`);
  } else {
    process.stderr.write("creating chat-db ...\n");
    const created = JSON.parse(wdl(["d1", "create", "chat-db", "--ns", "demo", "--json"]));
    if (!created?.databaseId) die("d1 create returned unexpected payload");
  }
  // chat-db binds by name — no database_id to patch (the CLI resolves it per --ns).
  process.stderr.write("applying migrations ...\n");
  wdl(["d1", "migrations", "apply", "chat-db", "--ns", "demo"], {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: path.join(REPO, "workers/chat"),
  });
}

async function mintIssuerToken() {
  const ADMIN_URL = process.env.ADMIN_URL;
  const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;
  if (!ADMIN_URL) die("--mint-issuer needs ADMIN_URL");
  if (!BOOTSTRAP_TOKEN) die("--mint-issuer needs BOOTSTRAP_TOKEN (an ops token)");
  const res = await fetch(`${ADMIN_URL}/auth/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": BOOTSTRAP_TOKEN },
    body: JSON.stringify({ kind: "token-issuer", issueTemplates: [ISSUE_TEMPLATE], label: "wdl-chat ns-pool issuer" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`POST /auth/tokens (token-issuer) failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const j = await res.json();
  if (!j?.token || !j?.tokenId) die(`/auth/tokens response missing token/tokenId (keys: ${Object.keys(j ?? {}).join(", ") || "none"})`);
  process.stderr.write(`  minted token-issuer ${j.tokenId} (revoke any earlier ones you no longer use)\n`);
  return j.token;
}

function putIssuerSecret(token) {
  process.stderr.write("storing TOKEN_ISSUER_TOKEN secret ...\n");
  wdl(
    ["secret", "put", "TOKEN_ISSUER_TOKEN", "--worker", "chat-worker", "--ns", "demo"],
    { input: token, stdio: ["pipe", "inherit", "inherit"], encoding: undefined },
  );
}

async function main() {
  ensureChatDb();

  if (values["skip-issuer"]) {
    process.stderr.write("[skip-issuer] not storing the token-issuer credential\n");
    return;
  }

  let token;
  if (values["mint-issuer"]) {
    process.stderr.write("minting token-issuer credential (operator path) ...\n");
    token = await mintIssuerToken();
  } else {
    token = process.env.TOKEN_ISSUER_TOKEN;
    if (!token) {
      die("TOKEN_ISSUER_TOKEN env required — the delegated token-issuer credential from your "
        + "operator (or pass --mint-issuer to mint one with an ops token)");
    }
  }

  putIssuerSecret(token);
  process.stderr.write(
    `\ndone. TOKEN_ISSUER_TOKEN stored on chat-worker; it mints per-session tmp namespaces `
    + `from template "${ISSUE_TEMPLATE}".\n`,
  );
}

main().catch(err => {
  process.stderr.write(`bootstrap: ${err?.stack || err?.message || err}\n`);
  process.exit(1);
});

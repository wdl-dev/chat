# Security Policy

## Supported Versions

wdl-chat is a continuously-deployed service; only the current `main` (what runs
at chat.wdl.dev) receives security fixes.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting instead: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/wdl-dev/chat/security/advisories/new>).

Include reproduction steps and, where relevant, the worker versions involved.
Please allow the maintainers a reasonable window to ship a fix before any public
disclosure.

If the reporting form is unavailable, email <security@wdl.dev> instead.

## Scope

wdl-chat runs untrusted, AI-directed code on behalf of anonymous users inside
per-session sandboxes, so the isolation and credential boundaries are the
sensitive surface. Reports are particularly welcome about:

- **Sandbox isolation** — escaping the per-session MicroVM, or reaching another
  session's workspace, namespace, or MicroVM. The boundary is the Firecracker VM
  plus a non-root uid; path-confinement bypasses in `sandbox-agent` (symlink /
  traversal in read / write / export / upload) are in scope.
- **Cross-session / cross-tenant access** — anything that lets a session act on a
  namespace, token, or MicroVM that isn't its own.
- **Credential handling** — the broker is the sole holder of the AWS key; the
  per-session namespace tokens are short-lived and delegated. Leaks, over-broad
  tokens, or secrets reaching the tenant/transcript are in scope.
- **Output rendering** — the chat UI renders model- and tool-supplied content;
  HTML/script injection (XSS) in the rendered conversation or preview is in
  scope.
- **Request forgery / SSRF** against the control plane, the broker, or the
  MicroVM endpoints.

The in-VM `sandbox-agent` trusts its inbound requests: its `/run`, `/write-file`, `/export`
etc. endpoints are authenticated by the **Lambda proxy's JWE, not by the agent itself**, and that
proxy is the only intended network path to the MicroVM. A path that reaches a MicroVM endpoint
without the proxy would make those endpoints unauthenticated, so such reports are in scope.

The `run_command` blocklist (wdl deploy / npm install / wrangler deploy / etc.) is a best-effort
guardrail to steer the agent toward the `deploy_test` tool, **not** a security boundary — a
determined or prompt-injected agent can bypass it (e.g. via an interpreter like `node -e`). That is
acceptable because the boundary is the VM + non-root uid: a bypass still can't escape the sandbox.

Out of scope: the AI's per-session namespace token is deliberately visible to
the code running inside that session's own sandbox — the boundary is the VM, not
env secrecy. There is also no application-layer rate limiting or quota on session
creation (`/portal/start`): as a passcode-gated demo it relies on the passcode and
short token TTLs rather than throttling, so passcode brute-force and
resource-exhaustion through mass session creation are out of scope. Closed-session data is not
reaped — the `sessions_index` row and per-session Durable Object SQLite persist until a retention
policy is added. Within a session, transcript size is bounded per tool_result (256 KiB), per turn
(`MAX_TOOL_USES_PER_TURN`), and per run (`MAX_TURNS`), but there is no cumulative per-session byte
budget, so a determined session can grow its own DO SQLite — a resource/cost concern, not
cross-tenant. Issues that require already having compromised the host or AWS account are also out of
scope.

The session id is a bearer secret carried in the request URL (path + `#fragment`). The fragment
never leaves the browser, but the path (`/api/sessions/<id>/…`) can appear in gateway/proxy access
logs, so treat a session URL as sensitive. Moving it to an `Authorization` header is a
production-hardening step, not done for this demo.

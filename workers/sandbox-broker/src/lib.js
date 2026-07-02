// Pure broker lifecycle logic with the AWS transport injected (testable without cloudflare:workers).

const API_VERSION = "2025-09-09";
const AUTH_TOKEN_MINUTES = 30;
const RUNNING_POLL_MS = 1000;
const RUNNING_POLL_MAX = 40;
const IDLE_SUSPEND_SECONDS = 10 * 60;
const SUSPENDED_TERMINATE_SECONDS = 30 * 60;
const MAX_LIFETIME_SECONDS = 2 * 60 * 60;

export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// authToken arrives as { "X-aws-proxy-auth": "..." }, sometimes already unwrapped.
export function parseAuthToken(r) {
  const authToken = r?.authToken?.["X-aws-proxy-auth"] ?? r?.authToken;
  if (typeof authToken !== "string") throw new Error("broker: auth-token response missing X-aws-proxy-auth");
  return authToken;
}

// Match the `-> 404:` status marker from #aws, not a stray 404 in a body.
export function isMicrovmNotFound(err) {
  return /-> 404:/.test(err?.message ?? "");
}

export async function mintAuthToken(aws, microvmId, now) {
  const r = await aws("POST", `/${API_VERSION}/microvms/${encodeURIComponent(microvmId)}/auth-token`, {
    expirationInMinutes: AUTH_TOKEN_MINUTES,
    allowedPorts: [{ port: 8080 }],
  });
  return { authToken: parseAuthToken(r), expiresAt: now() + AUTH_TOKEN_MINUTES * 60_000 };
}

export async function closeMicrovm(aws, microvmId) {
  if (!microvmId) return { ok: true };
  try {
    await aws("DELETE", `/${API_VERSION}/microvms/${encodeURIComponent(microvmId)}`);
  } catch (err) {
    if (!isMicrovmNotFound(err)) throw err;
  }
  return { ok: true };
}

// deps: { aws(method, pathPart, body?), initSession(endpoint, authToken, init), env, sleep(ms), now() }.
export async function openMicrovm(deps, { sessionId, ns, adminUrl, nsToken }) {
  if (!sessionId) throw new Error("broker: sessionId required");
  const { aws, initSession, env, sleep, now } = deps;

  const run = await aws("POST", `/${API_VERSION}/microvms`, {
    imageIdentifier: env.MICROVM_IMAGE_ARN,
    ingressNetworkConnectors: [env.INGRESS_CONNECTOR_ARN],
    egressNetworkConnectors: [env.EGRESS_CONNECTOR_ARN],
    idlePolicy: {
      autoResumeEnabled: true,
      maxIdleDurationSeconds: IDLE_SUSPEND_SECONDS,
      suspendedDurationSeconds: SUSPENDED_TERMINATE_SECONDS,
    },
    maximumDurationInSeconds: MAX_LIFETIME_SECONDS,
  });
  const microvmId = run.microvmId;
  // Any failure past this point must terminate the VM or it orphans.
  try {
    let endpoint = run.endpoint;
    let state = run.state;
    let stateReason = run.stateReason;
    for (let i = 0; i < RUNNING_POLL_MAX && state !== "RUNNING"; i++) {
      if (/FAIL|TERMINAT/.test(state ?? "")) {
        throw new Error(`broker: microvm ${microvmId} ${state}: ${stateReason ?? ""}`);
      }
      await sleep(RUNNING_POLL_MS);
      const g = await aws("GET", `/${API_VERSION}/microvms/${encodeURIComponent(microvmId)}`);
      state = g.state;
      stateReason = g.stateReason ?? stateReason;
      endpoint = g.endpoint ?? endpoint;
    }
    if (state !== "RUNNING") {
      throw new Error(`broker: microvm ${microvmId} not RUNNING after poll (last ${state})`);
    }
    const { authToken, expiresAt } = await mintAuthToken(aws, microvmId, now);
    await initSession(endpoint, authToken, { sessionId, ns, adminUrl, nsToken });
    return { microvmId, endpoint, authToken, authTokenExpiresAt: expiresAt };
  } catch (err) {
    await closeMicrovm(aws, microvmId).catch(() => {});
    throw err;
  }
}

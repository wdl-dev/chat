import { WorkerEntrypoint } from "cloudflare:workers";
import { SigV4Client } from "@wdl-dev/aws-sigv4";
import { closeMicrovm, mintAuthToken, openMicrovm, realSleep } from "./lib.js";

// Lambda MicroVMs lifecycle broker; sole holder of the AWS IAM key, RPC-only.
// The SigV4 transport lives here; the lifecycle logic lives in lib.js.

// External-call budgets so a hung AWS/proxy or agent connection can't stall openSession/cleanup/close.
const AWS_CALL_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 15_000;

// microvmId is caller-supplied over RPC; enforce its assumed AWS-id shape before it reaches the API path.
const MICROVM_ID_RE = /^[A-Za-z0-9._~-]+$/;
function assertMicrovmId(microvmId) {
  if (typeof microvmId !== "string" || !MICROVM_ID_RE.test(microvmId)) {
    throw new Error("broker: invalid microvmId");
  }
}

export class Broker extends WorkerEntrypoint {
  #clientInstance = null;

  #client() {
    if (this.#clientInstance) return this.#clientInstance;
    const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION } = this.env;
    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      throw new Error("broker: AWS credentials not configured");
    }
    if (!AWS_REGION) throw new Error("broker: AWS_REGION not configured");
    this.#clientInstance = new SigV4Client({
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      service: "lambda",
      region: AWS_REGION,
      // Retry transient 429/5xx on idempotent calls (the ~40 GET status polls, DELETE) so one blip
      // during openMicrovm doesn't hit the catch and DELETE a healthy VM. POST create isn't idempotent
      // → never retried, so no duplicate MicroVM.
      retries: 2,
    });
    return this.#clientInstance;
  }

  // Arrow field so it can be handed to lib.js as a self-bound transport.
  #aws = async (method, pathPart, body) => {
    const init = { method, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.#client().fetch(
      `https://lambda.${this.env.AWS_REGION}.amazonaws.com${pathPart}`,
      init,
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`lambda-microvms ${method} ${pathPart} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  };

  #initSession = async (endpoint, authToken, init) => {
    const res = await fetch(`https://${endpoint}/init`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-aws-proxy-auth": authToken },
      body: JSON.stringify(init),
      signal: AbortSignal.timeout(INIT_TIMEOUT_MS), // a hung /init throws → openMicrovm's catch runs closeMicrovm
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`broker: agent /init -> ${res.status}: ${text.slice(0, 300)}`);
  };

  #deps() {
    return { aws: this.#aws, initSession: this.#initSession, env: this.env, sleep: realSleep, now: Date.now };
  }

  async openSession(params) {
    return await openMicrovm(this.#deps(), params);
  }

  async mintToken({ microvmId }) {
    assertMicrovmId(microvmId);
    return await mintAuthToken(this.#aws, microvmId, Date.now);
  }

  async closeSession({ microvmId }) {
    assertMicrovmId(microvmId);
    return await closeMicrovm(this.#aws, microvmId);
  }
}

// wrangler requires a default export; this only answers stray HTTP probes.
export default {
  async fetch() {
    return new Response("broker: RPC-only (use the Broker service binding)", { status: 404 });
  },
};

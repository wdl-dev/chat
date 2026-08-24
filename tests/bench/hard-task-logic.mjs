// Compare the complete canonical deploy artifact, not the tools used to produce it. Missing
// metadata fails closed for both equality and change.
export const sameCode = (prevMeta, meta) => typeof prevMeta?.artifactDigest === "string"
  && meta?.artifactDigest === prevMeta.artifactDigest;

export const changedCode = (prevMeta, meta) => typeof prevMeta?.artifactDigest === "string"
  && typeof meta?.artifactDigest === "string"
  && meta.artifactDigest !== prevMeta.artifactDigest;

export const rowIdentityAbsent = (rows, id, title) => Array.isArray(rows)
  && !rows.some(row => row?.id === id && row?.title === title);

const parseBody = (body) => {
  if (body && typeof body === "object" && !Array.isArray(body)) return body;
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};

// Classify only requests call_preview actually resolves onto the mounted app, mirroring its
// resolution exactly — one leading slash removed, then resolved against the REAL preview base, so
// an absolute same-origin probe counts (the tool accepts it) while ../ escapes, lookalike names,
// foreign origins, and query-string words cannot impersonate a required verification probe.
export function todoProbeKind(input, previewUrl) {
  const rawPath = typeof input?.path === "string" && input.path !== "" ? input.path : "/";
  let relative;
  try {
    const raw = String(previewUrl);
    const base = new URL(raw.endsWith("/") ? raw : `${raw}/`);
    const resolved = new URL(rawPath.replace(/^\//, ""), base);
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return null;
    relative = resolved.pathname.slice(base.pathname.length);
  } catch { return null; }

  const method = String(input?.method ?? "GET").toUpperCase();
  const collection = /^api\/todos\/?$/.test(relative);
  if (method === "GET" && collection) return "list";
  if (method === "POST" && /^api\/todos\/[^/]+\/toggle\/?$/.test(relative)) return "toggle";
  if (method !== "POST" || !collection) return null;

  const body = parseBody(input?.body);
  if (typeof body?.title === "string" && body.title.trim() !== "") return "create";
  if (body && (!Object.hasOwn(body, "title")
    || (typeof body.title === "string" && body.title.trim() === ""))) return "validate";
  return null;
}

// ---- deterministic asset-ownership layer (survives from the parser era) ----------------------
// A host a real visitor's browser cannot reach, or a special-purpose range that never serves the
// public web. Scoring only: the network boundary itself is the browser judge's allowlist.
const isPrivateV4 = (v4) =>
  /^(127|10|169\.254|192\.168|0)\./.test(v4) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)
  || /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(v4) || /^198\.1[89]\./.test(v4)
  || /^192\.0\.2\./.test(v4) || /^198\.51\.100\./.test(v4) || /^203\.0\.113\./.test(v4)
  || /^(22[4-9]|23[0-9]|24[0-9]|25[0-5])\./.test(v4);
const isPrivateIp = (raw) => {
  const h = raw.toLowerCase();
  const dotted = h.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return isPrivateV4(dotted);
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
    return isPrivateV4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (h.includes(":")) {
    return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89a-f]/.test(h)
      || /^ff/.test(h) || /^2001:db8:/.test(h);
  }
  return false;
};
export const isPrivateHost = (hostname) => {
  // URL.hostname retains IPv6 brackets and a DNS root dot; both are syntax, not identity.
  const h = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")
    || h.endsWith(".internal") || isPrivateIp(h);
};

const CANONICAL_ASSET_RE = /(?:^|\/)assets\/([^/]+)\/([^/]+)\/([0-9a-f]{28})\/(.+)$/i;
// A 200 from the CDN is not enough: it may be an old token, another namespace, or a global path.
// Resolve the canonical identity and require the path to exist in THIS packaged artifact.
export const deployedAssetRef = (
  href,
  ns,
  assetPaths,
  { assetsHost = "assets.wdl.dev", assetProtocol = "https:", fixedWorkerName = "app" } = {},
) => {
  try {
    const u = new URL(href);
    if (u.host !== assetsHost || u.protocol !== assetProtocol) return null;
    const m = u.pathname.match(CANONICAL_ASSET_RE);
    if (!m) return null;
    const deployedNs = decodeURIComponent(m[1]);
    const worker = decodeURIComponent(m[2]);
    const assetPath = m[4].split("/").map(decodeURIComponent).join("/");
    if (deployedNs !== ns || worker !== fixedWorkerName || !assetPaths.has(assetPath)) return null;
    return { token: m[3].toLowerCase(), path: assetPath };
  } catch { return null; }
};

// ---- browser-snapshot aggregates -------------------------------------------------------------
// The judge's snapshot: pageOk/apiOk/witnessRendered are observed browser facts; loadedAssets is
// Map<manifestPath, { token, kind, digest }> of bounded successful canonical-CDN responses, where
// script/style mean Chromium actually executed/applied the resource. assetTokens is deliberately
// separate from that path-keyed map: two versions of the same path must remain two observed tokens
// instead of one silently overwriting the other. Blocked public externals and console messages are
// diagnostics; boundary/resource failures and uncaught page exceptions fail the browser verdict.
export const currentAssetToken = (snap) => {
  const tokens = snap?.assetTokens instanceof Set ? snap.assetTokens : new Set();
  const token = tokens.size === 1 ? [...tokens][0] : null;
  return typeof token === "string" && /^[0-9a-f]{28}$/.test(token) ? token : null;
};
const loadedKinds = (snap) => new Set([...(snap?.loadedAssets?.values() ?? [])].map(a => a.kind));
// Execution facts in one place; asset-graph health in the other. Every scored inspection asserts
// both, so neither aggregate needs to restate the other's conditions.
export const browserOk = (snap) => snap?.pageOk === true
  && snap.witnessRendered === true
  && snap.apiOk === true
  && (snap.violations?.length ?? 1) === 0
  && (snap.pageErrors?.length ?? 1) === 0;
export const deployedAssetsOk = (snap, meta) =>
  Number.isSafeInteger(meta?.assetCount) && meta.assetCount > 0
  && Array.isArray(meta.assetPaths) && meta.assetPaths.length === meta.assetCount
  && loadedKinds(snap).has("script") && loadedKinds(snap).has("style")
  && currentAssetToken(snap) !== null;
export const rotatedAssetsOk = (snap, meta, previousToken) => deployedAssetsOk(snap, meta)
  && typeof previousToken === "string" && /^[0-9a-f]{28}$/.test(previousToken)
  && currentAssetToken(snap) !== previousToken;
// Token excluded on purpose: it rotates on every deploy, so keying change on it would make ANY
// redeploy read as a restyle. Identity is the manifest path; change is the served bytes.
export const digestMapChanged = (a, b) => {
  const flat = (snap) => [...(snap?.loadedAssets ?? new Map())]
    .map(([path, v]) => `${path}\0${v.digest}`).sort().join("\n");
  return flat(a) !== flat(b);
};

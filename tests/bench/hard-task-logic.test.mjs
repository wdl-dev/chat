import assert from "node:assert/strict";
import test from "node:test";

import { changedCode, rowIdentityAbsent, sameCode, todoProbeKind } from "./hard-task-logic.mjs";

test("artifact comparisons fail closed when either digest is missing", () => {
  const one = { artifactDigest: "one" };
  const two = { artifactDigest: "two" };

  assert.equal(sameCode(one, { artifactDigest: "one" }), true);
  assert.equal(sameCode(one, two), false);
  assert.equal(sameCode(null, null), false);
  assert.equal(changedCode(one, two), true);
  assert.equal(changedCode(one, { artifactDigest: "one" }), false);
  assert.equal(changedCode(one, null), false);
  assert.equal(changedCode(null, two), false);
});

test("a reused id does not resurrect a deleted row with a different title", () => {
  const reused = [{ id: 7, title: "verification row", done: false }];
  assert.equal(rowIdentityAbsent(reused, 7, "feed cat"), true);
  assert.equal(rowIdentityAbsent([{ id: 7, title: "feed cat", done: false }], 7, "feed cat"), false);
  assert.equal(rowIdentityAbsent(null, 7, "feed cat"), false);
});

test("todo probe classification matches call_preview routing and exact endpoint shapes", () => {
  const PREVIEW = "https://tmp-1234.wdl.sh/app/";
  const kind = (probe) => todoProbeKind(probe, PREVIEW);
  assert.equal(kind({ path: "/api/todos", method: "GET" }), "list");
  assert.equal(kind({ path: "api/todos?after=toggle", method: "post", body: '{"title":"x"}' }), "create");
  assert.equal(kind({ path: "/api/todos/7/toggle", method: "POST" }), "toggle");
  assert.equal(kind({ path: "/api/todos", method: "POST", body: {} }), "validate");
  assert.equal(kind({ path: "/api/todos", method: "POST", body: { title: "  " } }), "validate");
  // call_preview resolves against the real preview base and accepts a same-origin absolute URL —
  // the classifier must count what the tool would actually serve, and only that origin.
  assert.equal(kind({ path: "https://tmp-1234.wdl.sh/app/api/todos", method: "GET" }), "list");
  assert.equal(kind({ path: "https://other.wdl.sh/app/api/todos", method: "GET" }), null);

  for (const probe of [
    { path: "/not-todos", method: "GET" },
    { path: "/api/todos-extra", method: "GET" },
    { path: "../api/todos", method: "GET" },
    { path: "/api/todos/7/not-toggle", method: "POST" },
    { path: "/api/todos", method: "POST", body: "not json" },
    { path: "/api/todos", method: "POST", body: { title: 7 } },
  ]) assert.equal(kind(probe), null, JSON.stringify(probe));
});

test("asset ownership resolves canonical CDN identity against the manifest", async () => {
  const { deployedAssetRef, isPrivateHost } = await import("./hard-task-logic.mjs");
  const TOK = "a".repeat(28);
  const paths = new Set(["styles.css", "js/app.js"]);
  const u = (ns, w, tok, p) => `https://assets.wdl.dev/assets/${ns}/${w}/${tok}/${p}`;
  assert.equal(deployedAssetRef(u("tmp-x", "app", TOK, "js/app.js"), "tmp-x", paths)?.token, TOK);
  assert.equal(deployedAssetRef(u("tmp-y", "app", TOK, "styles.css"), "tmp-x", paths), null);
  assert.equal(deployedAssetRef(u("tmp-x", "evil", TOK, "styles.css"), "tmp-x", paths), null);
  assert.equal(deployedAssetRef(u("tmp-x", "app", TOK, "unlisted.bin"), "tmp-x", paths), null);
  assert.equal(deployedAssetRef(`http://assets.wdl.dev/assets/tmp-x/app/${TOK}/styles.css`, "tmp-x", paths), null);
  assert.equal(
    deployedAssetRef(`http://assets.wdl.dev/assets/tmp-x/app/${TOK}/styles.css`, "tmp-x", paths, { assetProtocol: "http:" })?.path,
    "styles.css",
  );
  for (const [h, want] of [["[::1]", true], ["[::ffff:7f00:1]", true], ["localhost.", true],
                           ["224.0.0.1", true], ["223.5.5.5", false], ["fonts.googleapis.com", false]]) {
    assert.equal(isPrivateHost(h), want, h);
  }
});

test("browser-snapshot aggregates demand execution facts, both asset kinds, one token", async () => {
  const { browserOk, deployedAssetsOk, rotatedAssetsOk, currentAssetToken, digestMapChanged } =
    await import("./hard-task-logic.mjs");
  const TOK = "a".repeat(28), TOK2 = "b".repeat(28);
  const snap = (over = {}) => ({
    pageOk: true, apiOk: true, witnessRendered: true, violations: [], pageErrors: [],
    assetTokens: new Set([TOK]),
    loadedAssets: new Map([
      ["styles.css", { token: TOK, kind: "style", digest: "d1" }],
      ["app.js", { token: TOK, kind: "script", digest: "d2" }],
    ]),
    ...over,
  });
  const meta = { assetCount: 2, assetPaths: ["styles.css", "app.js"] };

  assert.equal(browserOk(snap()), true);
  for (const bad of [{ pageOk: false }, { apiOk: false }, { witnessRendered: false },
                     { violations: [{ kind: "private-target", url: "x" }] },
                     { pageErrors: ["broken bundle"] }]) {
    assert.equal(browserOk(snap(bad)), false, JSON.stringify(bad));
  }
  assert.equal(deployedAssetsOk(snap(), meta), true);
  // one kind missing / mixed tokens / stale metadata all fail closed
  assert.equal(deployedAssetsOk(snap({ loadedAssets: new Map([["a.css", { token: TOK, kind: "style", digest: "d" }]]) }), meta), false);
  const mixed = snap();
  // The path-keyed map cannot represent both loads. The independent token evidence must retain
  // them, so an old+new URL for the same app.js never looks like one clean current deployment.
  mixed.assetTokens = new Set([TOK, TOK2]);
  assert.equal(currentAssetToken(mixed), null);
  assert.equal(currentAssetToken(snap({ assetTokens: new Set([undefined]) })), null);
  assert.equal(deployedAssetsOk(mixed, meta), false);
  assert.equal(deployedAssetsOk(snap(), { assetCount: 2 }), false);

  assert.equal(rotatedAssetsOk(snap(), meta, TOK2), true);
  assert.equal(rotatedAssetsOk(snap(), meta, TOK), false);
  assert.equal(rotatedAssetsOk(snap(), meta, null), false);
  assert.equal(rotatedAssetsOk(snap(), meta, undefined), false);
  assert.equal(rotatedAssetsOk(snap(), meta, "not-a-token"), false);

  // change keyed by path+digest; the per-deploy token must NOT register as change
  const rotatedOnly = snap();
  rotatedOnly.assetTokens = new Set([TOK2]);
  rotatedOnly.loadedAssets = new Map([...snap().loadedAssets].map(([p, v]) => [p, { ...v, token: TOK2 }]));
  assert.equal(digestMapChanged(snap(), rotatedOnly), false);
  const restyled = snap();
  restyled.loadedAssets = new Map(snap().loadedAssets);
  restyled.loadedAssets.set("styles.css", { token: TOK, kind: "style", digest: "NEW" });
  assert.equal(digestMapChanged(snap(), restyled), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { promptPack, isPlanConfirmMarker } from "../src/agent-prompt.js";

test("promptPack defaults to en for unknown / missing language", () => {
  assert.equal(promptPack("en"), promptPack(undefined));
  assert.equal(promptPack("en"), promptPack("fr"));
  assert.notEqual(promptPack("en"), promptPack("zh"));
});

test("each pack exposes the full prompt surface", () => {
  for (const lang of ["en", "zh"]) {
    const p = promptPack(lang);
    for (const key of ["system", "planSystem", "planConfirmMarker"]) {
      assert.equal(typeof p[key], "string", `${lang}.${key}`);
      assert.ok(p[key].length > 0, `${lang}.${key} non-empty`);
    }
    for (const fn of ["planSuffix", "anchorSuffix"]) {
      assert.equal(typeof p[fn]("X"), "string", `${lang}.${fn}`);
    }
    assert.equal(typeof p.assetsSuffix(["a", "b"]), "string", `${lang}.assetsSuffix`);
  }
});

test("en pack is English, zh pack is Chinese", () => {
  assert.match(promptPack("en").system, /open source under Apache-2\.0/);
  assert.match(promptPack("zh").system, /以 Apache-2\.0 开源/);
});

test("isPlanConfirmMarker matches both languages' markers, nothing else", () => {
  assert.ok(isPlanConfirmMarker(promptPack("en").planConfirmMarker));
  assert.ok(isPlanConfirmMarker(promptPack("zh").planConfirmMarker));
  assert.ok(!isPlanConfirmMarker("an ordinary user message"));
});

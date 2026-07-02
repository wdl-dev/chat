import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Mirrors scripts/build-agents-md.mjs output so an edited .md that wasn't
// regenerated fails CI instead of silently shipping a stale sandbox AGENTS.md.
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");
const VARIANTS = [
  { src: "agents-md.md", out: "agents-md.gen.js" },
  { src: "agents-md.en.md", out: "agents-md.en.gen.js" },
];

test("agents-md .gen.js files are in sync with their .md sources", () => {
  for (const { src, out } of VARIANTS) {
    const md = readFileSync(join(srcDir, src), "utf8");
    const expected =
      `// Auto-generated from ${src} by scripts/build-agents-md.mjs.\n` +
      "// Do NOT edit by hand — edit the .md and re-run the script.\n" +
      "export default " + JSON.stringify(md) + ";\n";
    const actual = readFileSync(join(srcDir, out), "utf8");
    assert.equal(actual, expected, `${out} is stale — run: node scripts/build-agents-md.mjs`);
  }
});

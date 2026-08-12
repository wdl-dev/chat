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

// A tool the model can call but that no doc or UI knows about renders as a raw name in the UI and
// gets prompted for wrongly.
test("every tool definition reaches both AGENTS.md packs, the prompt body, and the frontend", async () => {
  const { TOOL_DEFINITIONS, promptPack } = await import("../src/agent-prompt.js");
  const read = (p) => readFileSync(join(srcDir, p), "utf8");
  const [zh, en, app] = [read("agents-md.md"), read("agents-md.en.md"), read("../../frontend/public/app.js")];
  const prompts = ["zh", "en"].map((lang) => promptPack(lang).system).join("\n");

  const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
  for (const { name } of TOOL_DEFINITIONS) {
    assert.ok(zh.includes(`\`${name}(`), `${name} missing from agents-md.md`);
    assert.ok(en.includes(`\`${name}(`), `${name} missing from agents-md.en.md`);
    // Once per STRINGS pack — a single hit means one language silently renders the raw tool name.
    assert.ok(occurrences(app, `"tool.${name}"`) >= 2, `${name} needs a frontend verb in BOTH language packs`);
    assert.ok(new RegExp(`TOOL_NAMES[^)]*"${name}"`, "s").test(app), `${name} missing from the frontend TOOL_NAMES set`);
  }
  for (const name of ["read_file", "write_file", "edit_file", "list_files"]) {
    assert.ok(prompts.includes(name), `${name} missing from the system prompt's file-tool guidance`);
  }
});

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

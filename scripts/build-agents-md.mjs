#!/usr/bin/env node
// Generate agents-md.gen.js / agents-md.en.gen.js from the .md sources so
// chat-worker can import the content without a bundler text-loader. Edit the
// .md, run this, commit both the .md and the .gen.js.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const srcDir = join(repoRoot, "workers/chat/src");

const VARIANTS = [
  { src: "agents-md.md", out: "agents-md.gen.js" },       // zh
  { src: "agents-md.en.md", out: "agents-md.en.gen.js" }, // en (default)
];

for (const { src, out } of VARIANTS) {
  const md = readFileSync(join(srcDir, src), "utf8");
  const body =
    `// Auto-generated from ${src} by scripts/build-agents-md.mjs.\n` +
    "// Do NOT edit by hand — edit the .md and re-run the script.\n" +
    "export default " + JSON.stringify(md) + ";\n";
  const outPath = join(srcDir, out);
  writeFileSync(outPath, body);
  console.log(`wrote ${outPath} (${body.length} bytes)`);
}

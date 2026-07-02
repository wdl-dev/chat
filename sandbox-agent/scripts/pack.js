// WIRE: stdout is the manifest only; control 400s on the full wrapper.

import { packWranglerProject } from "/opt/wdl-cli/lib/wrangler-pack.js";

const cwd = process.env.WDL_PACK_CWD || "/workspace";

// Sandbox deploys the base config (no --env, per AGENTS.md); WDL_DEPLOY_ENV overrides for debugging.
const envName = process.env.WDL_DEPLOY_ENV || undefined;

try {
  const result = await packWranglerProject({
    cwd,
    projectDir: cwd,
    envName,
    env: process.env,
    stdout: () => {},
    stderr: () => {},
  });
  process.stdout.write(JSON.stringify(result.manifest));
} catch (err) {
  process.stderr.write(String(err?.stack || err?.message || err));
  process.exit(1);
}

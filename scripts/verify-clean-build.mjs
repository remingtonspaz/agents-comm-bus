#!/usr/bin/env node
// AGE-29: clean-build guard. Rebuilds every tracked generated artifact from
// source, then fails if any of them drifted from what's committed — i.e. a
// commit edited source (e.g. the host install path, the daemon, an adapter)
// without rebuilding the esbuild bundles / staged plugins.
//
// This catches the stale-MCP-shim class (the shims INLINE executeInstallPlan /
// ensure-daemon, so editing the install path without rebundling silently ships
// stale install logic), plus daemon-bundle / staged-plugin drift, in one shot.
//
// Run on the SAME OS the committed artifacts were built on (Windows for this
// project) — esbuild/tsc output can differ across platforms, so a cross-OS run
// would report spurious drift. The CI workflow pins windows-latest for this.
//
// Usage: node scripts/verify-clean-build.mjs   (npm run verify:clean-build)
// Exit 0 = all artifacts match source; exit 1 = stale artifacts (and they are
// left rebuilt in the working tree, ready to commit).
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only the tracked generated trees. dist-bundle/ is gitignored (intermediate).
const ARTIFACT_PATHS = ["agents-comm-bus/dist", "mcp-server/dist", "plugins"];

function run(cmd) {
  console.log(`\n[verify-clean-build] $ ${cmd}`);
  execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}

// Build order matches the documented fresh-clone order (core-contracts first —
// the daemon resolves agents-comm-bus-core from its built dist).
run("npm --workspace packages/core-contracts run build");
run("npm --workspace agents-comm-bus run build:all"); // tsc + copy-assets + bundles
run("npm --workspace hosts run build"); // esbuilds the MCP shims into mcp-server/dist/
run("node scripts/stage-plugins.js");

const status = execSync(`git status --porcelain -- ${ARTIFACT_PATHS.join(" ")}`, {
  cwd: repoRoot,
  encoding: "utf8",
});

if (status.trim()) {
  console.error(
    "\n[verify-clean-build] ✖ STALE GENERATED ARTIFACTS\n\n" +
      "These regenerated differently from what is committed — a source change landed\n" +
      "without rebuilding its bundle/staged output:\n\n" +
      status +
      "\nFix: run the build + `node scripts/stage-plugins.js` and commit the regenerated\n" +
      "artifacts (this is the 'rebundle mcp-server after touching the install path' rule).\n",
  );
  process.exit(1);
}

console.log("\n[verify-clean-build] ✓ all generated artifacts match source.");

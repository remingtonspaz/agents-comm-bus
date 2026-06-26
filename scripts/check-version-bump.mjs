#!/usr/bin/env node
// AGE-25: CI version-bump gate. Central-install superseding keys ONLY on the
// version string (DAEMON_VERSION / ADAPTER_VERSION, compared highest-wins in
// reconcile-central-install.js). So if a shipped central artifact's BYTES change
// but its version does not bump, a marketplace update looks "same version" and
// the installer leaves users on the stale artifact.
//
// This gate fails when a shipped artifact changed in the change set without a
// matching version bump. It runs AFTER verify:clean-build (AGE-29), which
// guarantees the committed bundle == a fresh build from source — so "bytes
// changed" reduces to "the staged bundle changed vs base", and there is no need
// to store a fingerprint or change anything at runtime (the committed/marketplace
// version stays 100% trustworthy).
//
// Usage: node scripts/check-version-bump.mjs [baseRef]
//   baseRef defaults to env BASE_REF, else origin/main (the integration branch
//   since the 2026-06-02 flip; the old origin/universal-overhaul default made
//   local runs silently SKIP once that ref disappeared — an AGE-10-review find).
import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  adapterBumpNpmScript,
  adapterBundlePathMatcher,
  adapterVersionRelPath,
  discoverCommAdapters,
} from "./comm-adapters.mjs";
import { evaluateVersionBump } from "./check-version-bump-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = process.argv[2] || process.env.BASE_REF || "origin/main";

function git(args) {
  return execSync(`git ${args}`, { cwd: repoRoot, encoding: "utf8" });
}

function fileAtRef(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null; // file absent at that ref (e.g. first-ship bundle path)
  }
}

function fileExistsAtRef(ref, file) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${file}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Each shipped, centrally-superseded artifact: the version source that gates its
// supersede, and a matcher for the staged bundle whose change signals "bytes
// changed". (The CLI bundle is NOT here — it is not centrally superseded.)
/** @type {Array<{label:string, versionFile:string, versionConst:string, match:(f:string)=>boolean, bumpCmd:string}>} */
const SURFACES = [
  {
    // The admin CLI rides under the daemon version (AGE-30): it ships from the
    // same core-daemon package and is centrally installed alongside the daemon,
    // so a cli.bundle.js change requires a DAEMON_VERSION bump too.
    label: "daemon",
    versionFile: "core-daemon/config.ts",
    versionConst: "DAEMON_VERSION",
    match: (f) => /(^|\/)(daemon|cli)\.bundle\.js$/.test(f),
    bumpCmd: "npm run bump:daemon",
  },
];

for (const comm of await discoverCommAdapters(repoRoot)) {
  SURFACES.push({
    label: `${comm} adapter`,
    versionFile: adapterVersionRelPath(comm),
    versionConst: "ADAPTER_VERSION",
    match: (f) => adapterBundlePathMatcher(comm).test(f),
    bumpCmd: adapterBumpNpmScript(comm),
  });
}

let baseSha;
try {
  baseSha = git(`rev-parse ${baseRef}`).trim();
} catch {
  // Shallow clone, first push, or unknown base — nothing to compare against.
  console.log(`[check-version-bump] base ref "${baseRef}" not found; skipping (nothing to compare).`);
  process.exit(0);
}

const changed = git(`diff --name-only ${baseSha} HEAD`).trim().split("\n").filter(Boolean);

const failures = evaluateVersionBump({
  changed,
  baseRef: baseSha,
  surfaces: SURFACES,
  fileAtRef,
  fileExistsAtRef,
});

if (failures.length > 0) {
  console.error("\n[check-version-bump] ✖ VERSION NOT BUMPED\n");
  for (const f of failures) {
    console.error(
      `  ${f.label}: shipped bundle changed but ${f.versionConst} is still "${f.baseVer}".`,
    );
    console.error(`    changed: ${f.files.join(", ")}`);
    console.error(
      `    fix: \`${f.bumpCmd}\` (edits ${f.versionConst} in ${f.versionFile}),\n` +
        `         then \`npm run verify:clean-build\` to restage with the new version.\n`,
    );
  }
  console.error(
    "Central-install superseding keys on the version, so an unbumped change would\n" +
      "leave existing installs running the stale artifact.\n",
  );
  process.exit(1);
}

console.log("[check-version-bump] ✓ every changed central artifact has a matching version bump (or none changed).");

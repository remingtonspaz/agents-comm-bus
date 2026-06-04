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
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = process.argv[2] || process.env.BASE_REF || "origin/main";

function git(args) {
  return execSync(`git ${args}`, { cwd: repoRoot, encoding: "utf8" });
}

function fileAtRef(ref, file) {
  try {
    return git(`show ${ref}:${file}`);
  } catch {
    return null; // file absent at that ref (e.g. a brand-new surface)
  }
}

function readConst(content, name) {
  if (content == null) return null;
  const m = content.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

// Each shipped, centrally-superseded artifact: the version source that gates its
// supersede, and a matcher for the staged bundle whose change signals "bytes
// changed". (The CLI bundle is NOT here — it is not centrally superseded.)
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
  {
    label: "telegram adapter",
    versionFile: "adapters/telegram/version.ts",
    versionConst: "ADAPTER_VERSION",
    match: (f) => /(^|\/)telegram\.adapter\.bundle\.js$/.test(f),
    bumpCmd: "npm run bump:adapter",
  },
];

let baseSha;
try {
  baseSha = git(`rev-parse ${baseRef}`).trim();
} catch {
  // Shallow clone, first push, or unknown base — nothing to compare against.
  console.log(`[check-version-bump] base ref "${baseRef}" not found; skipping (nothing to compare).`);
  process.exit(0);
}

const changed = git(`diff --name-only ${baseSha} HEAD`).trim().split("\n").filter(Boolean);

const failures = [];
for (const s of SURFACES) {
  const files = changed.filter(s.match);
  if (files.length === 0) continue; // artifact bytes unchanged → no bump required

  const baseVer = readConst(fileAtRef(baseSha, s.versionFile), s.versionConst);
  const headVer = readConst(fileAtRef("HEAD", s.versionFile), s.versionConst);
  if (baseVer == null) continue; // surface did not exist at base → nothing to supersede

  if (baseVer === headVer) {
    failures.push({ ...s, baseVer, files });
  }
}

if (failures.length > 0) {
  console.error("\n[check-version-bump] ✖ VERSION NOT BUMPED\n");
  for (const f of failures) {
    console.error(
      `  ${f.label}: shipped bundle changed but ${f.versionConst} is still "${f.baseVer}".`,
    );
    console.error(`    changed: ${f.files.join(", ")}`);
    console.error(
      `    fix: \`${f.bumpCmd} [patch|minor|major]\` (edits ${f.versionConst} in ${f.versionFile}),\n` +
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

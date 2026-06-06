#!/usr/bin/env node
// AGE-25: bump a central artifact's version constant. The CI version-bump gate
// (check-version-bump.mjs) points here when a shipped bundle changed without a
// version bump. You choose which semver part to increment — the version is the
// supersede/downgrade-ordering key, so a breaking change should be a minor/major,
// not a blind patch.
//
// Usage:
//   node scripts/bump-version.mjs daemon  [patch|minor|major]
//   node scripts/bump-version.mjs adapter <comm> [patch|minor|major]
// (npm run bump:daemon / bump:adapter -- <comm> [level])
//
// After bumping, run `npm run verify:clean-build` to restage artifacts (the new
// version is embedded into plugins/**/install-stamp.json).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  adapterBumpNpmScript,
  adapterVersionRelPath,
  discoverCommAdapters,
} from "./comm-adapters.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DAEMON_SURFACE = { file: "core-daemon/config.ts", konst: "DAEMON_VERSION" };

const surfaceArg = process.argv[2];
const commArg = process.argv[3];
const levelArg = process.argv[4];

let surface;
let level;

if (surfaceArg === "daemon") {
  surface = DAEMON_SURFACE;
  level = commArg ?? "patch";
} else if (surfaceArg === "adapter") {
  const comms = await discoverCommAdapters(repoRoot);
  if (comms.length === 0) {
    console.error("bump-version: no comm adapters discovered under adapters/<comm>/");
    process.exit(1);
  }
  const comm = commArg && !["patch", "minor", "major"].includes(commArg) ? commArg : comms[0];
  if (!comms.includes(comm)) {
    console.error(`bump-version: unknown comm "${comm}" (discovered: ${comms.join(", ")})`);
    process.exit(1);
  }
  surface = { file: adapterVersionRelPath(comm), konst: "ADAPTER_VERSION", comm };
  level =
    commArg && ["patch", "minor", "major"].includes(commArg)
      ? commArg
      : levelArg && ["patch", "minor", "major"].includes(levelArg)
        ? levelArg
        : "patch";
} else {
  console.error('bump-version: first arg must be "daemon" or "adapter"');
  process.exit(2);
}

if (!["patch", "minor", "major"].includes(level)) {
  console.error(`bump-version: level must be patch | minor | major (got "${level}")`);
  process.exit(2);
}

function nextVersion(version, lvl) {
  const core = version.split("-")[0];
  const parts = core.split(".").map((n) => Number(n));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`cannot bump non-semver version "${version}"`);
  }
  const [maj, min, pat] = parts;
  if (lvl === "major") return `${maj + 1}.0.0`;
  if (lvl === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const absFile = path.join(repoRoot, surface.file);
const content = await readFile(absFile, "utf8");
const re = new RegExp(`(export const ${surface.konst}\\s*=\\s*")([^"]+)(")`);
const m = content.match(re);
if (!m) {
  console.error(`bump-version: could not find "export const ${surface.konst}" in ${surface.file}`);
  process.exit(1);
}
const current = m[2];
const next = nextVersion(current, level);
await writeFile(absFile, content.replace(re, `$1${next}$3`), "utf8");

const label = surface.comm ? `${surface.comm} adapter` : "daemon";
console.log(`[bump-version] ${label} ${surface.konst}: ${current} -> ${next} (${level}) in ${surface.file}`);
console.log("Next: run `npm run verify:clean-build` to restage artifacts with the new version.");
if (surface.comm) {
  console.log(`(equivalent: \`${adapterBumpNpmScript(surface.comm, level)}\`)`);
}

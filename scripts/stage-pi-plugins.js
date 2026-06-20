#!/usr/bin/env node
// stage-pi-plugins.js — emit release artifacts (bundles + install-stamp) for
// Pi per-comm packages.
//
// Pi's staging shape is simpler than Claude/Codex: no MCP shim, no hooks, no
// plugin manifest localization. Each per-comm package just needs:
//   1. daemon.bundle.js (self-contained daemon — same one Claude/Codex use)
//   2. <comm>.adapter.bundle.js (the comm adapter)
//   3. cli.bundle.js (the admin CLI)
//   4. SQL schema sidecars (next to daemon.bundle.js)
//   5. install-stamp.json (so entryEnsures can supersede a stale daemon)
//
// Usage:
//   node scripts/stage-pi-plugins.js [--verify] [--dry-run]
//
// Artifacts are written into plugins/pi/<comm>/ (the in-repo source of truth).
// The release sync (copying to the agents-comm-bus-pi-<comm> release repos)
// happens separately.

import { copyFile, mkdir, readdir, readFile, writeFile, access, rm } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import { pathToFileURL } from "node:url";

import { buildInstallStamp } from "../agents-comm-bus/dist/core-daemon/host-runtime/install-stamp.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BUNDLE_DIR = resolve(REPO_ROOT, "agents-comm-bus", "dist-bundle");
const PI_PLUGINS_DIR = resolve(REPO_ROOT, "plugins", "pi");

const args = process.argv.slice(2);
const verifyMode = args.includes("--verify");
const dryRun = args.includes("--dry-run");

function repoRelative(p) {
  return relative(REPO_ROOT, p).replace(/\\/g, "/");
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function writeJson(p, obj) {
  await writeFile(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function loadDistExport(distRelPath, exportName) {
  const abs = resolve(REPO_ROOT, distRelPath);
  if (!(await pathExists(abs))) {
    throw new Error(`stage-pi-plugins: missing ${distRelPath} (run the agents-comm-bus build first)`);
  }
  const mod = await import(pathToFileURL(abs).href);
  const value = mod[exportName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`stage-pi-plugins: ${exportName} missing/invalid in ${distRelPath}`);
  }
  return value;
}

async function copyBundle(src, dst) {
  if (dryRun) {
    console.log(`  [dry-run] copy ${repoRelative(src)} -> ${repoRelative(dst)}`);
    return;
  }
  await mkdir(resolve(dst, ".."), { recursive: true });
  await copyFile(src, dst);
  console.log(`  copied ${repoRelative(dst)}`);
}

async function discoverPiComms() {
  if (!(await pathExists(PI_PLUGINS_DIR))) {
    return [];
  }
  const entries = await readdir(PI_PLUGINS_DIR, { withFileTypes: true });
  const comms = entries
    .filter((e) => e.isDirectory() && e.name !== "core")
    .map((e) => e.name)
    .sort();
  return comms;
}

async function stagePiComm(comm) {
  const outDir = resolve(PI_PLUGINS_DIR, comm);
  const commPkgJsonPath = resolve(outDir, "package.json");

  if (!(await pathExists(commPkgJsonPath))) {
    console.log(`  skipping ${comm} (no package.json — stub only)`);
    return;
  }

  const commPkg = await readJson(commPkgJsonPath);
  const pluginVersion = commPkg.version ?? "0.0.0";

  console.log(`Staging pi/${comm} (plugin_version=${pluginVersion})`);

  // 1. Runtime bundles
  const bundles = ["daemon.bundle.js", `${comm}.adapter.bundle.js`, "cli.bundle.js"];
  for (const bundleName of bundles) {
    const src = resolve(BUNDLE_DIR, bundleName);
    if (!(await pathExists(src))) {
      throw new Error(
        `Missing bundle ${bundleName} in ${repoRelative(BUNDLE_DIR)}. ` +
          `Run 'npm --workspace agents-comm-bus run build:bundles'.`,
      );
    }
    const dst = resolve(outDir, bundleName);
    await copyBundle(src, dst);
  }

  // 2. SQL schema sidecars
  const allFiles = await readdir(BUNDLE_DIR);
  const schemaFiles = allFiles.filter((f) => f.endsWith(".sql")).sort();
  for (const sqlName of schemaFiles) {
    const src = resolve(BUNDLE_DIR, sqlName);
    const dst = resolve(outDir, sqlName);
    await copyBundle(src, dst);
  }

  // 3. Install stamp
  const daemonBundleVersion = await loadDistExport(
    "agents-comm-bus/dist/core-daemon/config.js",
    "DAEMON_VERSION",
  );
  const adapterBundleVersion = await loadDistExport(
    `agents-comm-bus/dist/adapters/${comm}/version.js`,
    "ADAPTER_VERSION",
  );

  const stamp = buildInstallStamp({
    agent: "pi",
    comm,
    pluginVersion,
    daemonBundleVersion,
    adapterBundleVersion,
    daemonSidecars: schemaFiles,
  });

  const stampDst = resolve(outDir, "install-stamp.json");
  if (dryRun) {
    console.log(`  [dry-run] write ${repoRelative(stampDst)}`);
  } else {
    await writeJson(stampDst, stamp);
    console.log(`  wrote ${repoRelative(stampDst)}`);
  }

  // 4. Verify (if --verify)
  if (verifyMode) {
    const written = await readJson(stampDst);
    if (written.daemon_bundle_version !== daemonBundleVersion) {
      throw new Error(`verify: daemon_bundle_version mismatch in ${comm}`);
    }
    if (written.adapter_bundle_version !== adapterBundleVersion) {
      throw new Error(`verify: adapter_bundle_version mismatch in ${comm}`);
    }
    if (written.agent !== "pi") {
      throw new Error(`verify: agent mismatch in ${comm}`);
    }
    console.log(`  verified ${repoRelative(stampDst)}`);
  }
}

async function main() {
  console.log(`stage-pi-plugins ${verifyMode ? "--verify" : ""} ${dryRun ? "--dry-run" : ""}`);

  if (!(await pathExists(BUNDLE_DIR))) {
    console.error(`Bundle dir not found: ${repoRelative(BUNDLE_DIR)}`);
    console.error("Run 'npm --workspace agents-comm-bus run build:bundles' first.");
    process.exit(1);
  }

  const comms = await discoverPiComms();
  if (comms.length === 0) {
    console.log("No Pi comm packages found in plugins/pi/");
    process.exit(0);
  }

  console.log(`Found Pi comm packages: ${comms.join(", ")}`);
  for (const comm of comms) {
    await stagePiComm(comm);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

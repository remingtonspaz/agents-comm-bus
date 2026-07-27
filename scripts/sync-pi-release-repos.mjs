#!/usr/bin/env node
// Sync or verify Pi release repos from monorepo plugins/pi/* staging artifacts.
//
// Usage (exactly one mode flag required):
//   node scripts/sync-pi-release-repos.mjs --write --release-root <path> --core-ref <40-hex>
//   node scripts/sync-pi-release-repos.mjs --verify --release-root <path> --core-ref <40-hex>
//
// --monorepo-root defaults to the repo containing this script.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatMismatches,
  syncAllReleases,
  validateCoreRef,
  verifyAllReleases,
} from "./lib/sync-pi-release.mjs";

const defaultMonorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSyncPiReleaseArgs(argv) {
  const opts = {
    monorepoRoot: defaultMonorepoRoot,
    releaseRoot: null,
    coreRef: null,
    mode: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verify") {
      if (opts.mode) {
        throw new Error("pass exactly one of --write or --verify");
      }
      opts.mode = "verify";
    } else if (arg === "--write") {
      if (opts.mode) {
        throw new Error("pass exactly one of --write or --verify");
      }
      opts.mode = "write";
    } else if (arg === "--monorepo-root") opts.monorepoRoot = path.resolve(argv[++i]);
    else if (arg === "--release-root") opts.releaseRoot = path.resolve(argv[++i]);
    else if (arg === "--core-ref") opts.coreRef = argv[++i];
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.mode) {
    throw new Error("pass exactly one of --write or --verify");
  }
  if (!opts.releaseRoot) {
    throw new Error("--release-root is required");
  }
  if (!opts.coreRef) {
    throw new Error("--core-ref is required (40-character git commit SHA of agents-comm-bus-pi-core)");
  }
  validateCoreRef(opts.coreRef);
  return opts;
}

export async function runSyncPiReleaseCli(
  argv,
  {
    syncReleases = syncAllReleases,
    verifyReleases = verifyAllReleases,
    stdout = console.log,
    stderr = console.error,
  } = {},
) {
  const opts = parseSyncPiReleaseArgs(argv);

  if (opts.mode === "verify") {
    const { reports, mismatches } = await verifyReleases({
      monorepoRoot: opts.monorepoRoot,
      releaseRoot: opts.releaseRoot,
      coreRef: opts.coreRef,
    });
    if (mismatches.length > 0) {
      for (const report of reports) {
        const text = formatMismatches(report.repo, report.mismatches);
        if (text) stderr(text);
      }
      return 1;
    }
    stdout(
      `verify:pi-release-sync OK (${reports.length} repos, core-ref=${opts.coreRef})`,
    );
    return 0;
  }

  await syncReleases({
    monorepoRoot: opts.monorepoRoot,
    releaseRoot: opts.releaseRoot,
    coreRef: opts.coreRef,
    removeStale: true,
  });

  const { reports, mismatches } = await verifyReleases({
    monorepoRoot: opts.monorepoRoot,
    releaseRoot: opts.releaseRoot,
    coreRef: opts.coreRef,
  });
  if (mismatches.length > 0) {
    for (const report of reports) {
      const text = formatMismatches(report.repo, report.mismatches);
      if (text) stderr(text);
    }
    return 1;
  }

  stdout(
    `sync:pi-release-repos wrote 5 repos (core-ref=${opts.coreRef}); verify OK`,
  );
  return 0;
}

async function main() {
  const code = await runSyncPiReleaseCli(process.argv.slice(2));
  if (code !== 0) {
    process.exit(code);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

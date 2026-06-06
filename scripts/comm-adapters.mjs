#!/usr/bin/env node
// Shared comm-adapter discovery for release tooling (AGE-40).
//
// Scans adapters/<comm>/ for the version.ts + factory.ts pair that marks a
// shippable comm adapter. Used by build-bundles, check-version-bump, and
// bump-version so new adapters are picked up without hardcoding comm ids.
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} [repoRoot]
 * @returns {Promise<string[]>} sorted comm ids (e.g. ["telegram"])
 */
export async function discoverCommAdapters(repoRoot = defaultRepoRoot) {
  const adaptersDir = path.join(repoRoot, "adapters");
  let entries;
  try {
    entries = await readdir(adaptersDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const comms = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const base = path.join(adaptersDir, entry.name);
    try {
      await access(path.join(base, "version.ts"));
      await access(path.join(base, "factory.ts"));
      comms.push(entry.name);
    } catch {
      // Not a shippable adapter surface — skip.
    }
  }
  return comms.toSorted();
}

/** @param {string} comm */
export function adapterVersionRelPath(comm) {
  return `adapters/${comm}/version.ts`;
}

/** @param {string} comm */
export function adapterBundleFileName(comm) {
  return `${comm}.adapter.bundle.js`;
}

/** @param {string} comm */
export function adapterBundleDistRelPath(comm) {
  return `agents-comm-bus/dist/adapters/${comm}/version.js`;
}

/**
 * Matcher for git-diff paths that signal a given comm's staged adapter bundle changed.
 * @param {string} comm
 */
export function adapterBundlePathMatcher(comm) {
  return new RegExp(`(^|/)${comm}\\.adapter\\.bundle\\.js$`);
}

/**
 * @param {string} comm
 * @param {"patch"|"minor"|"major"} [level]
 */
export function adapterBumpNpmScript(comm, level = "patch") {
  return `npm run bump:adapter -- ${comm} ${level}`;
}

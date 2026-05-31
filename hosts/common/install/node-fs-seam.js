/**
 * Concrete node-backed pieces for central install: the real `FsSeam` that
 * `executeInstallPlan` writes through, and the path resolver for the shared
 * `~/.agents-comm-bus/` code layout. Kept in a sibling file so
 * `reconcile-central-install.js` stays import-free and trivially unit-testable
 * (T1 needs no fs at all); this is the I/O edge the real install hook uses.
 */
import { mkdir, copyFile, writeFile, rename, access, readFile, chmod } from "node:fs/promises";
import path from "node:path";

import { stripBom } from "./strip-bom.js";

/**
 * Real filesystem seam backed by node:fs/promises.
 * @returns {import("./reconcile-central-install.js").FsSeam}
 */
export function createNodeFsSeam() {
  return {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    copyFile: async (from, to) => {
      await copyFile(from, to);
    },
    writeFile: async (file, data) => {
      await writeFile(file, data, "utf8");
    },
    chmod: async (file, mode) => {
      await chmod(file, mode);
    },
  };
}

/**
 * Atomic filesystem seam: every write lands via a same-directory temp file
 * followed by an atomic rename, so a reader (or a crash) never observes a
 * half-written bundle or truncated JSON — only old-good or new-good. Verified
 * safe on Windows even when a running daemon has the target .js imported (node
 * closes the handle after import, unlike a locked .exe image).
 *
 * Safe to use a fixed `.tmp` suffix because runCentralInstall holds the global
 * install lock, so there is exactly one writer at a time.
 *
 * @returns {import("./reconcile-central-install.js").FsSeam}
 */
export function createAtomicNodeFsSeam() {
  return {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    copyFile: async (from, to) => {
      const tmp = `${to}.tmp`;
      await copyFile(from, tmp);
      await rename(tmp, to);
    },
    writeFile: async (file, data) => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, data, "utf8");
      await rename(tmp, file);
    },
    chmod: async (file, mode) => {
      await chmod(file, mode);
    },
  };
}

/**
 * Read the current central-install state for one comm from disk, in the shape
 * reconcileInstall expects. This is the real hook flow's read step: read fs →
 * build CentralState → reconcile. `daemonRunning` is left false here (it is a
 * discovery-probe concern, not a filesystem one); the caller overrides it if
 * it has a live daemon handshake.
 *
 * @param {string} stateRoot
 * @param {string} comm
 * @returns {Promise<import("./reconcile-central-install.js").CentralState>}
 */
export async function readCentralState(stateRoot, comm) {
  const paths = resolveCentralPaths(stateRoot, comm);
  return {
    daemonExists: await pathExists(paths.daemonBundle),
    daemonVersionFile: await readJsonOrNull(paths.daemonVersionFile),
    adapterExists: await pathExists(paths.adapterBundle),
    adapterVersionFile: await readJsonOrNull(paths.adapterVersionFile),
    daemonRunning: false,
  };
}

/** @param {string} p */
async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} p */
async function readJsonOrNull(p) {
  try {
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Resolve the central-install code paths for one comm under a state root.
 * Separates code (`bin/`, `adapters/`) from daemon state, per install-model.md.
 *
 * @param {string} stateRoot   e.g. ~/.agents-comm-bus
 * @param {string} comm        e.g. "telegram"
 * @returns {import("./reconcile-central-install.js").CentralPaths}
 */
export function resolveCentralPaths(stateRoot, comm) {
  const bin = path.join(stateRoot, "bin");
  const adapters = path.join(stateRoot, "adapters");
  return {
    daemonBundle: path.join(bin, "daemon.js"),
    daemonVersionFile: path.join(bin, "version.json"),
    // The admin CLI is centrally installed next to the daemon (it rides under
    // the daemon version) so `agents-comm` / `agents-comm-bus` work without npm.
    cliBundle: path.join(bin, "cli.js"),
    adapterBundle: path.join(adapters, `${comm}.js`),
    adapterVersionFile: path.join(adapters, `${comm}.version.json`),
  };
}

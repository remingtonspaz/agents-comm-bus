/**
 * Concrete node-backed pieces for central install: the real `FsSeam` that
 * `executeInstallPlan` writes through, and the path resolver for the shared
 * `~/.agents-comm-bus/` code layout. Kept in a sibling file so
 * `reconcile-central-install.js` stays import-free and trivially unit-testable
 * (T1 needs no fs at all); this is the I/O edge the real install hook uses.
 */
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  };
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
    adapterBundle: path.join(adapters, `${comm}.js`),
    adapterVersionFile: path.join(adapters, `${comm}.version.json`),
  };
}

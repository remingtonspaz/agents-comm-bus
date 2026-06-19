import { mkdir, copyFile, writeFile, rename, access, readFile, chmod } from "node:fs/promises";
import path from "node:path";

import type { CentralState, CentralPaths, FsSeam } from "./reconcile-central-install.js";
import { stripBom } from "./strip-bom.js";

export function createNodeFsSeam(): FsSeam {
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

export function createAtomicNodeFsSeam(): FsSeam {
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

export async function readCentralState(stateRoot: string, comm: string): Promise<CentralState> {
  const paths = resolveCentralPaths(stateRoot, comm);
  return {
    daemonExists: await pathExists(paths.daemonBundle),
    daemonVersionFile: await readJsonOrNull(paths.daemonVersionFile),
    adapterExists: await pathExists(paths.adapterBundle),
    adapterVersionFile: await readJsonOrNull(paths.adapterVersionFile),
    daemonRunning: false,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrNull(p: string): Promise<import("./reconcile-central-install.js").VersionRecord | null> {
  try {
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  } catch {
    return null;
  }
}

export function resolveCentralPaths(stateRoot: string, comm: string): CentralPaths {
  const bin = path.join(stateRoot, "bin");
  const adapters = path.join(stateRoot, "adapters");
  return {
    daemonBundle: path.join(bin, "daemon.js"),
    daemonVersionFile: path.join(bin, "version.json"),
    cliBundle: path.join(bin, "cli.js"),
    adapterBundle: path.join(adapters, `${comm}.js`),
    adapterVersionFile: path.join(adapters, `${comm}.version.json`),
  };
}

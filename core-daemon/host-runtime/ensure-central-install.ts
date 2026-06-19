import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { runCentralInstall as defaultRunCentralInstall } from "./run-central-install.js";
import { readCentralState as defaultReadCentralState } from "./node-fs-seam.js";
import { stripBom } from "./strip-bom.js";
import type { InstallActor, FsSeam, ReconcilePlan, ExecutionResult } from "./reconcile-central-install.js";
import type { InstallLockOptions } from "./install-lock.js";

export const INSTALL_STAMP_NAME = "install-stamp.json";

export interface InstallStamp {
  schema_version: number;
  agent?: string;
  comm?: string;
  plugin_version: string;
  daemon_bundle_version: string;
  adapter_bundle_version: string;
  adapter_bundle_versions?: Record<string, string>;
  daemon_sidecars?: string[];
}

export type InstallMode = "source" | "production";

export interface EnsureCentralInstallOptions {
  stateRoot: string;
  agent?: string;
  comm?: string;
  pluginInstallDir?: string;
  env?: Record<string, string | undefined>;
  installedAt?: string;
  daemonRunning?: boolean;
  readOnlyIfCentralInstalled?: boolean;
  lock?: InstallLockOptions;
  deps?: EnsureCentralInstallDeps;
}

export interface EnsureCentralInstallDeps {
  readFile?: typeof readFile;
  readCentralState?: typeof defaultReadCentralState;
  runCentralInstall?: typeof defaultRunCentralInstall;
  fs?: FsSeam;
}

export interface EnsureCentralInstallResult {
  mode: InstallMode;
  skipped?: boolean;
  actor?: InstallActor;
  plan?: ReconcilePlan;
  result?: ExecutionResult;
  stoleStale?: boolean;
}

export function resolveInstallMode(env: Record<string, string | undefined>): InstallMode {
  return env && env.AGENTS_COMM_BUS_BIN ? "source" : "production";
}

export async function readInstallStamp(
  pluginInstallDir: string | undefined,
  deps: EnsureCentralInstallDeps = {},
): Promise<InstallStamp | null> {
  if (!pluginInstallDir) return null;
  const read = deps.readFile ?? readFile;
  try {
    const raw = await read(path.join(pluginInstallDir, INSTALL_STAMP_NAME), "utf8");
    const parsed = JSON.parse(stripBom(raw)) as InstallStamp;
    if (
      !parsed ||
      parsed.schema_version !== 1 ||
      typeof parsed.plugin_version !== "string" ||
      typeof parsed.daemon_bundle_version !== "string" ||
      typeof parsed.adapter_bundle_version !== "string" ||
      !isValidAdapterBundleVersionsMap(parsed.adapter_bundle_versions)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function ensureCentralInstall(options: EnsureCentralInstallOptions): Promise<EnsureCentralInstallResult> {
  const env = options.env ?? process.env;
  const mode = resolveInstallMode(env);

  if (mode === "source") {
    return { mode: "source", skipped: true };
  }

  const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
  if (!options.pluginInstallDir || !stamp) {
    if (options.stateRoot && existsSync(path.join(options.stateRoot, "bin", "daemon.js"))) {
      return { mode: "production", skipped: true };
    }
    throw new Error(
      `central install (production mode): missing or invalid plugin install metadata.\n` +
        `  - no source-mode signal (no AGENTS_COMM_BUS_BIN, no .agents-comm-bus-dev.json marker resolved)\n` +
        `  - no valid packaged install artifact (expected ${INSTALL_STAMP_NAME} under ` +
        `pluginInstallDir=${options.pluginInstallDir ?? "<unset>"})\n` +
        `Fix one of:\n` +
        `  - source/dev checkout: create .agents-comm-bus-dev.json at the repo root ` +
        `(see .agents-comm-bus-dev.json.example), or set AGENTS_COMM_BUS_BIN\n` +
        `  - packaged install: provide the staged plugin artifacts incl. ${INSTALL_STAMP_NAME}`,
    );
  }

  const resolvedAgent = options.agent ?? stamp.agent;
  const resolvedComm = options.comm ?? stamp.comm;
  const resolvedAdapterBundleVersion = resolveAdapterBundleVersion(stamp, resolvedComm ?? "");
  if (
    typeof resolvedAgent !== "string" ||
    resolvedAgent.length === 0 ||
    typeof resolvedComm !== "string" ||
    resolvedComm.length === 0
  ) {
    throw new Error(
      `central install (production mode): install stamp resolved an invalid actor identity ` +
        `(agent=${JSON.stringify(resolvedAgent)}, comm=${JSON.stringify(resolvedComm)}). ` +
        `The stamp must carry agent + comm, or the caller must supply them.`,
    );
  }

  const actor: InstallActor = {
    agent: resolvedAgent as InstallActor["agent"],
    comm: resolvedComm,
    pluginVersion: stamp.plugin_version,
    daemonBundleVersion: stamp.daemon_bundle_version,
    adapterBundleVersion: resolvedAdapterBundleVersion,
    pluginInstallDir: options.pluginInstallDir,
    installedAt: options.installedAt ?? new Date().toISOString(),
    ...(Array.isArray(stamp.daemon_sidecars) ? { daemonSidecars: stamp.daemon_sidecars } : {}),
  };

  if (
    await centralInstallContentIsCurrent(
      options.stateRoot,
      resolvedComm,
      stamp,
      resolvedAdapterBundleVersion,
      options.deps,
    )
  ) {
    return { mode: "production", actor, skipped: true };
  }

  if (
    options.readOnlyIfCentralInstalled &&
    (await centralInstallHasRunnableContent(options.stateRoot, resolvedComm, options.deps))
  ) {
    return { mode: "production", actor, skipped: true };
  }

  const run = options.deps?.runCentralInstall ?? defaultRunCentralInstall;
  const outcome = await run(options.stateRoot, actor, {
    fs: options.deps?.fs,
    lock: options.lock,
    daemonRunning: options.daemonRunning ?? false,
  });

  return { mode: "production", actor, ...outcome };
}

async function centralInstallContentIsCurrent(
  stateRoot: string,
  comm: string,
  stamp: InstallStamp,
  adapterBundleVersion: string,
  deps: EnsureCentralInstallDeps = {},
): Promise<boolean> {
  const readState = deps.readCentralState ?? defaultReadCentralState;
  try {
    const state = await readState(stateRoot, comm);
    return Boolean(
      state.daemonExists &&
        state.adapterExists &&
        state.daemonVersionFile?.content_version === stamp.daemon_bundle_version &&
        state.adapterVersionFile?.content_version === adapterBundleVersion,
    );
  } catch {
    return false;
  }
}

export function resolveAdapterBundleVersion(stamp: InstallStamp, comm: string): string {
  const fromMap = stamp.adapter_bundle_versions?.[comm];
  if (typeof fromMap === "string" && fromMap.length > 0) {
    return fromMap;
  }
  return stamp.adapter_bundle_version;
}

function isValidAdapterBundleVersionsMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0,
  );
}

async function centralInstallHasRunnableContent(
  stateRoot: string,
  comm: string,
  deps: EnsureCentralInstallDeps = {},
): Promise<boolean> {
  const readState = deps.readCentralState ?? defaultReadCentralState;
  try {
    const state = await readState(stateRoot, comm);
    return Boolean(state.daemonExists && state.adapterExists);
  } catch {
    return false;
  }
}

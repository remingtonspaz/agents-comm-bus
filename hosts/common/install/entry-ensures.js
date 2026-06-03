/**
 * entryEnsures — the single canonical "ensure the runtime is ready" path that
 * every host entrypoint (the per-agent hooks + the MCP shim) calls instead of
 * open-coding ensureCentralInstall + ensureDaemon themselves.
 *
 * Ordered contract (see install-model.md + AGE-13):
 *   1. Resolve dev-config: a gitignored repo-local marker is turned into
 *      env-shaped overrides (applyDevConfig) and merged onto the caller's env.
 *      resolveInstallMode stays env-only; this is just the convenience layer.
 *   2. ensureCentralInstall FIRST. In source/dev mode (AGENTS_COMM_BUS_BIN set)
 *      it skips central install; in production mode it REQUIRES a valid install
 *      stamp and throws if missing — and because it runs before ensureDaemon, a
 *      packaging failure is never masked by a spawned daemon.
 *   3. ensureDaemon. Its result is returned (with `centralInstall` attached) so
 *      existing callers keep using `{ port, hello, spawned }`.
 *
 * Inputs are explicit. process.env is only read as the outermost default here
 * (entryEnsures IS the outermost wrapper the hooks/shim call); inner logic uses
 * the passed/merged env. All collaborators are injectable for testing.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { ensureDaemon as defaultEnsureDaemon } from "../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js";
import { resolveStatePaths as defaultResolveStatePaths } from "../../../agents-comm-bus/dist/core-daemon/paths.js";
import { ensureCentralInstall as defaultEnsureCentralInstall } from "./ensure-central-install.js";
import { applyDevConfig, DEV_MARKER_NAME } from "./dev-config-resolver.js";
import { INSTALL_STAMP_NAME } from "./ensure-central-install.js";

/**
 * Derive the entry context for a calling hook/shim from its own directory, so
 * every entrypoint can pass just `fromDir` and get identical resolution:
 *   - projectRoot:      nearest ancestor containing the gitignored dev marker
 *                       (`.agents-comm-bus-dev.json`). In a source/dev checkout
 *                       this is the repo root; in a packaged install it is
 *                       absent (no marker shipped).
 *   - pluginInstallDir: nearest ancestor containing `install-stamp.json`. In a
 *                       packaged install this is the plugin root; in a dev
 *                       checkout it is absent (no committed stamp).
 *
 * Symmetric "nearest ancestor with marker X" walk for both, so the same hook
 * file resolves correctly whether it runs from the source tree or a staged
 * plugin dir.
 *
 * @param {string} fromDir
 * @param {{ exists?: (p: string) => boolean }} [deps]
 * @returns {{ projectRoot?: string, pluginInstallDir?: string }}
 */
export function resolveEntryContext(fromDir, deps = {}) {
  const exists = deps.exists ?? existsSync;
  return {
    projectRoot: findAncestorContaining(fromDir, DEV_MARKER_NAME, exists),
    pluginInstallDir: findAncestorContaining(fromDir, INSTALL_STAMP_NAME, exists),
  };
}

/** @returns {string|undefined} nearest ancestor of `dir` (inclusive) holding `name` */
function findAncestorContaining(dir, name, exists) {
  let current = path.resolve(dir);
  for (;;) {
    if (exists(path.join(current, name))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * @typedef {Object} EntryEnsuresOptions
 * @property {string} agent
 * @property {string} comm
 * @property {string} [stateRoot]
 * @property {string} [projectRoot]          repo/worktree root for the dev marker lookup
 * @property {string} [pluginInstallDir]     plugin artifact dir (production stamp source)
 * @property {Record<string,string|undefined>} [env]   defaults to process.env (outermost only)
 * @property {Object} [ensureDaemonOptions]  forwarded verbatim to ensureDaemon
 * @property {boolean} [daemonRunning]
 * @property {boolean} [readOnlyCentralInstall]
 *                      For sandboxed MCP startup: reuse an already-installed
 *                      central daemon+adapter without taking install.lock.
 * @property {EntryEnsuresDeps} [deps]
 *
 * @typedef {Object} EntryEnsuresDeps
 * @property {typeof defaultEnsureDaemon} [ensureDaemon]
 * @property {typeof defaultEnsureCentralInstall} [ensureCentralInstall]
 * @property {typeof defaultResolveStatePaths} [resolveStatePaths]  default-root resolver (injectable in tests so the fallback can't touch the real ~/.agents-comm-bus)
 * @property {import("./dev-config-resolver.js").DevConfigDeps} [devConfigDeps]
 * @property {import("./ensure-central-install.js").EnsureCentralInstallDeps} [centralInstallDeps]
 * @property {{ exists?: (p: string) => boolean }} [entryContextDeps]
 */

/**
 * @param {EntryEnsuresOptions} options
 */
export async function entryEnsures(options) {
  const {
    agent,
    comm,
    stateRoot,
    fromDir,
    projectRoot,
    pluginInstallDir,
    env = process.env,
    ensureDaemonOptions = {},
    daemonRunning = false,
    readOnlyCentralInstall = false,
    deps = {},
  } = options ?? {};

  const ensureDaemonFn = deps.ensureDaemon ?? defaultEnsureDaemon;
  const ensureCentralInstallFn = deps.ensureCentralInstall ?? defaultEnsureCentralInstall;

  // Hooks/shims pass their own dir; explicit projectRoot/pluginInstallDir still
  // win (used by tests). fromDir derives both via the symmetric marker walk.
  let resolvedProjectRoot = projectRoot;
  let resolvedPluginInstallDir = pluginInstallDir;
  if (fromDir && (resolvedProjectRoot === undefined || resolvedPluginInstallDir === undefined)) {
    const ctx = resolveEntryContext(fromDir, deps.entryContextDeps);
    resolvedProjectRoot = resolvedProjectRoot ?? ctx.projectRoot;
    resolvedPluginInstallDir = resolvedPluginInstallDir ?? ctx.pluginInstallDir;
  }

  // 1. Dev-config marker → merged env (no-op without a marker; never mutates the
  //    caller's env object).
  const resolvedEnv = resolvedProjectRoot
    ? applyDevConfig(env, resolvedProjectRoot, deps.devConfigDeps).env
    : env;

  // 1b. Derive ONE canonical state root and feed it to both ensureCentralInstall
  //     and ensureDaemon, so they never diverge. Precedence: explicit option ->
  //     resolved AGENTS_COMM_BUS_ROOT (marker/env) -> the daemon's own default
  //     (which honors AGENTS_COMM_BUS_STATE_ROOT, else ~/.agents-comm-bus).
  //     Live hooks/shim call entryEnsures WITHOUT an explicit stateRoot, so
  //     without this the production path passed undefined into runCentralInstall
  //     (path.join(undefined, ...) crash) and the daemon ensure never saw the
  //     marker-resolved root.
  const resolveStatePathsFn = deps.resolveStatePaths ?? defaultResolveStatePaths;
  const canonicalStateRoot =
    stateRoot ??
    resolvedEnv.AGENTS_COMM_BUS_ROOT ??
    resolveStatePathsFn({ stateRoot: resolvedEnv.AGENTS_COMM_BUS_STATE_ROOT }).root;

  // 2. Central install FIRST — production failures throw here, before any spawn.
  const centralInstall = await ensureCentralInstallFn({
    stateRoot: canonicalStateRoot,
    agent,
    comm,
    pluginInstallDir: resolvedPluginInstallDir,
    env: resolvedEnv,
    daemonRunning,
    readOnlyIfCentralInstalled: readOnlyCentralInstall,
    deps: deps.centralInstallDeps,
  });

  // 3. Then ensure the daemon with the SAME canonical root; return its result so
  //    callers keep using { port, hello, spawned }.
  const daemon = await ensureDaemonFn({
    ...ensureDaemonOptions,
    stateRoot: canonicalStateRoot,
    env: resolvedEnv,
  });
  return { ...daemon, centralInstall };
}

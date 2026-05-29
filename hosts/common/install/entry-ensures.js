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
import { ensureDaemon as defaultEnsureDaemon } from "../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js";
import { ensureCentralInstall as defaultEnsureCentralInstall } from "./ensure-central-install.js";
import { applyDevConfig } from "./dev-config-resolver.js";

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
 * @property {EntryEnsuresDeps} [deps]
 *
 * @typedef {Object} EntryEnsuresDeps
 * @property {typeof defaultEnsureDaemon} [ensureDaemon]
 * @property {typeof defaultEnsureCentralInstall} [ensureCentralInstall]
 * @property {import("./dev-config-resolver.js").DevConfigDeps} [devConfigDeps]
 * @property {import("./ensure-central-install.js").EnsureCentralInstallDeps} [centralInstallDeps]
 */

/**
 * @param {EntryEnsuresOptions} options
 */
export async function entryEnsures(options) {
  const {
    agent,
    comm,
    stateRoot,
    projectRoot,
    pluginInstallDir,
    env = process.env,
    ensureDaemonOptions = {},
    daemonRunning = false,
    deps = {},
  } = options ?? {};

  const ensureDaemonFn = deps.ensureDaemon ?? defaultEnsureDaemon;
  const ensureCentralInstallFn = deps.ensureCentralInstall ?? defaultEnsureCentralInstall;

  // 1. Dev-config marker → merged env (no-op without a marker; never mutates the
  //    caller's env object).
  const resolvedEnv = projectRoot ? applyDevConfig(env, projectRoot, deps.devConfigDeps).env : env;

  // 2. Central install FIRST — production failures throw here, before any spawn.
  const centralInstall = await ensureCentralInstallFn({
    stateRoot,
    agent,
    comm,
    pluginInstallDir,
    env: resolvedEnv,
    daemonRunning,
    deps: deps.centralInstallDeps,
  });

  // 3. Then ensure the daemon; return its result so callers keep {port, hello, spawned}.
  const daemon = await ensureDaemonFn(ensureDaemonOptions);
  return { ...daemon, centralInstall };
}

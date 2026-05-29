/**
 * Central-install entry contract — the mode-aware wrapper the per-agent install
 * hooks (and the MCP shim cold-start path) call BEFORE ensureDaemon.
 *
 * Settled mode contract (see install-model.md "Dev mode" + the design thread):
 *
 *   source/dev mode  — triggered by an explicit AGENTS_COMM_BUS_BIN env signal.
 *                      Skip central install entirely; the daemon runs from the
 *                      source checkout with project-local .agents-comm-bus-dev
 *                      state. Preserves the current Model A iteration loop.
 *
 *   production mode  — no source signal. REQUIRE a runtime-readable install
 *                      stamp (pluginInstallDir + bundle versions) and fail LOUD
 *                      if it is missing or invalid. A missing plugin dir in
 *                      production is a packaging/bootstrap bug we want surfaced,
 *                      never silently skipped. When present, build the
 *                      InstallActor from the stamp and run the serialized
 *                      runCentralInstall.
 *
 * The "missing plugin dir => skip" heuristic is deliberately NOT the contract:
 * explicit env signal is authoritative; absence of production metadata is an
 * error, not an inferred dev mode.
 *
 * This module is the contract + its wiring to runCentralInstall. It is NOT yet
 * called from the live ensureDaemon paths; that wiring is a separate, deliberate
 * step that must land together with dev configs setting AGENTS_COMM_BUS_BIN (or
 * it would hard-fail the current dev loop, which sets none of these vars).
 */
import path from "node:path";
import { readFile } from "node:fs/promises";

import { runCentralInstall as defaultRunCentralInstall } from "./run-central-install.js";

export const INSTALL_STAMP_NAME = "install-stamp.json";

/**
 * The runtime-readable version stamp expected at the plugin install root in
 * production. Distinct from .stage-manifest.json (which is build lineage, not
 * install-actor versions). Emitting this from the stage/assemble scripts is a
 * follow-up; this module defines its shape and reads it.
 *
 * @typedef {Object} InstallStamp
 * @property {number} schema_version
 * @property {string} [agent]   identity; may be omitted if the caller supplies options.agent
 * @property {string} [comm]    identity; may be omitted if the caller supplies options.comm
 * @property {string} plugin_version          provenance only
 * @property {string} daemon_bundle_version   bin/daemon.js replace key
 * @property {string} adapter_bundle_version  adapters/<comm>.js replace key
 *
 * @typedef {"source" | "production"} InstallMode
 *
 * @typedef {Object} EnsureCentralInstallOptions
 * @property {string} stateRoot
 * @property {string} [agent]                 falls back to the stamp's agent
 * @property {string} [comm]                  falls back to the stamp's comm
 * @property {string} [pluginInstallDir]      where the bundles + stamp live (production)
 * @property {Record<string,string|undefined>} [env]   defaults to process.env
 * @property {string} [installedAt]           ISO timestamp; defaults to now
 * @property {boolean} [daemonRunning]        pass-through to runCentralInstall
 * @property {import("./install-lock.js").InstallLockOptions} [lock]
 * @property {EnsureCentralInstallDeps} [deps]
 *
 * @typedef {Object} EnsureCentralInstallDeps  injectable seams for tests
 * @property {typeof readFile} [readFile]
 * @property {typeof defaultRunCentralInstall} [runCentralInstall]
 * @property {import("./reconcile-central-install.js").FsSeam} [fs]
 *
 * @typedef {Object} EnsureCentralInstallResult
 * @property {InstallMode} mode
 * @property {boolean} [skipped]              true in source mode
 * @property {import("./reconcile-central-install.js").InstallActor} [actor]
 * @property {import("./reconcile-central-install.js").ReconcilePlan} [plan]
 * @property {import("./reconcile-central-install.js").ExecutionResult} [result]
 * @property {boolean} [stoleStale]
 */

/**
 * Resolve install mode from the environment. PURE. Source mode is triggered
 * ONLY by an explicit AGENTS_COMM_BUS_BIN signal — never inferred.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {InstallMode}
 */
export function resolveInstallMode(env) {
  return env && env.AGENTS_COMM_BUS_BIN ? "source" : "production";
}

/**
 * Read + minimally validate the install stamp under a plugin install dir.
 * Returns null when absent, unreadable, unparseable, or missing required
 * version fields.
 *
 * @param {string | undefined} pluginInstallDir
 * @param {EnsureCentralInstallDeps} [deps]
 * @returns {Promise<InstallStamp | null>}
 */
export async function readInstallStamp(pluginInstallDir, deps = {}) {
  if (!pluginInstallDir) return null;
  const read = deps.readFile ?? readFile;
  try {
    const raw = await read(path.join(pluginInstallDir, INSTALL_STAMP_NAME), "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.schema_version !== 1 ||
      typeof parsed.plugin_version !== "string" ||
      typeof parsed.daemon_bundle_version !== "string" ||
      typeof parsed.adapter_bundle_version !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Mode-aware central-install entry point.
 *
 * @param {EnsureCentralInstallOptions} options
 * @returns {Promise<EnsureCentralInstallResult>}
 */
export async function ensureCentralInstall(options) {
  const env = options.env ?? process.env;
  const mode = resolveInstallMode(env);

  if (mode === "source") {
    // Daemon runs from source; central install is intentionally bypassed.
    return { mode: "source", skipped: true };
  }

  // Production mode is strict: a missing/invalid stamp is a hard error.
  const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
  if (!options.pluginInstallDir || !stamp) {
    throw new Error(
      `central install (production mode): missing or invalid plugin install metadata — ` +
        `expected ${INSTALL_STAMP_NAME} under pluginInstallDir=${options.pluginInstallDir ?? "<unset>"}. ` +
        `Set AGENTS_COMM_BUS_BIN for source/dev mode, or fix the plugin packaging.`,
    );
  }

  // Resolve actor identity (caller override wins, else the stamp) and validate
  // it before building the actor. Production-strict: an unresolved agent/comm
  // must fail loud, never flow into runCentralInstall and write paths like
  // adapters/undefined.js or metadata with an undefined comm.
  const resolvedAgent = options.agent ?? stamp.agent;
  const resolvedComm = options.comm ?? stamp.comm;
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

  /** @type {import("./reconcile-central-install.js").InstallActor} */
  const actor = {
    agent: /** @type {any} */ (resolvedAgent),
    comm: resolvedComm,
    pluginVersion: stamp.plugin_version,
    daemonBundleVersion: stamp.daemon_bundle_version,
    adapterBundleVersion: stamp.adapter_bundle_version,
    pluginInstallDir: options.pluginInstallDir,
    installedAt: options.installedAt ?? new Date().toISOString(),
  };

  const run = options.deps?.runCentralInstall ?? defaultRunCentralInstall;
  const outcome = await run(options.stateRoot, actor, {
    fs: options.deps?.fs,
    lock: options.lock,
    daemonRunning: options.daemonRunning ?? false,
  });

  return { mode: "production", actor, ...outcome };
}

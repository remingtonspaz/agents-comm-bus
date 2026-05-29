/**
 * Dev-config resolver — the workspace-convenience layer ABOVE the strict
 * source-mode contract (see install-model.md "Workspace-wide dev marker").
 *
 * `resolveInstallMode(env)` stays env-only and strict: source mode is triggered
 * solely by an explicit `AGENTS_COMM_BUS_BIN`. This resolver does NOT introduce
 * a second mode switch — it reads a gitignored, repo-local marker and turns it
 * into the SAME env-shaped values the strict contract already reads, which the
 * caller then merges into the env it passes to ensureCentralInstall. So the
 * marker resolves *into* the env contract; it is never itself a "skip central
 * install" signal.
 *
 * Safety (Codex review bars):
 *   - returns explicit env-shaped overrides; never mutates global process.env.
 *   - a marker that is missing, unparseable, lacks `daemonBin`, points OUTSIDE
 *     the project root, or references a non-existent daemon entry yields NO
 *     overrides (status "none"/"rejected") — a stale/wrong marker must not
 *     silently enable dev mode.
 *
 * The marker (`.agents-comm-bus-dev.json`, gitignored) at the project root:
 *   {
 *     "daemonBin":   "agents-comm-bus/dist/core-daemon/serve.js",  // required, repo-relative or absolute-inside-root
 *     "stateRoot":   ".agents-comm-bus-dev",                       // optional
 *     "adaptersDir": "adapters"                                     // optional
 *   }
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const DEV_MARKER_NAME = ".agents-comm-bus-dev.json";

/**
 * @typedef {Object} DevConfigResult
 * @property {Record<string,string>} env       env-shaped overrides to merge (empty unless a valid marker applied)
 * @property {"none"|"applied"|"rejected"} status
 * @property {string[]} reasons
 *
 * @typedef {Object} DevConfigDeps
 * @property {(p: string) => boolean} [exists]
 * @property {(p: string) => string} [readFile]
 */

/**
 * @param {string} projectRoot  absolute repo/worktree root for the calling hook/shim
 * @param {DevConfigDeps} [deps]
 * @returns {DevConfigResult}
 */
export function resolveDevConfig(projectRoot, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const markerPath = path.join(projectRoot, DEV_MARKER_NAME);

  if (!exists(markerPath)) {
    return { env: {}, status: "none", reasons: [`no dev marker at ${markerPath}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFile(markerPath));
  } catch (error) {
    // Present but unparseable: reject — never enable dev mode on a broken marker.
    return {
      env: {},
      status: "rejected",
      reasons: [`dev marker unparseable: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const daemonBinRaw = parsed && typeof parsed.daemonBin === "string" ? parsed.daemonBin : null;
  if (!daemonBinRaw) {
    return { env: {}, status: "rejected", reasons: ["dev marker missing string field `daemonBin`"] };
  }

  const daemonBin = path.resolve(projectRoot, daemonBinRaw);
  if (!isInside(projectRoot, daemonBin)) {
    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin escapes project root: ${daemonBinRaw}`] };
  }
  if (!exists(daemonBin)) {
    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin does not exist: ${daemonBin}`] };
  }

  /** @type {Record<string,string>} */
  const env = { AGENTS_COMM_BUS_BIN: daemonBin };
  const reasons = [`dev marker applied from ${markerPath}`];

  // Optional overrides — each validated inside the project root or ignored.
  if (typeof parsed.stateRoot === "string" && parsed.stateRoot.length > 0) {
    const stateRoot = path.resolve(projectRoot, parsed.stateRoot);
    if (isInside(projectRoot, stateRoot)) env.AGENTS_COMM_BUS_ROOT = stateRoot;
    else reasons.push(`ignoring stateRoot outside project root: ${parsed.stateRoot}`);
  }
  if (typeof parsed.adaptersDir === "string" && parsed.adaptersDir.length > 0) {
    const adaptersDir = path.resolve(projectRoot, parsed.adaptersDir);
    if (isInside(projectRoot, adaptersDir)) env.AGENTS_COMM_BUS_ADAPTERS_DIR = adaptersDir;
    else reasons.push(`ignoring adaptersDir outside project root: ${parsed.adaptersDir}`);
  }

  return { env, status: "applied", reasons };
}

/**
 * Merge resolved dev overrides onto a base env WITHOUT mutating the base.
 * Callers pass the result as ensureCentralInstall's `env`. The strict
 * `resolveInstallMode(env)` then reads AGENTS_COMM_BUS_BIN as usual.
 *
 * @param {Record<string, string | undefined>} baseEnv
 * @param {string} projectRoot
 * @param {DevConfigDeps} [deps]
 * @returns {{ env: Record<string, string | undefined>, devConfig: DevConfigResult }}
 */
export function applyDevConfig(baseEnv, projectRoot, deps = {}) {
  const devConfig = resolveDevConfig(projectRoot, deps);
  return { env: { ...baseEnv, ...devConfig.env }, devConfig };
}

/** True if `candidate` is `root` or strictly inside it. */
function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

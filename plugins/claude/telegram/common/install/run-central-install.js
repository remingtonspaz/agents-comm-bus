/**
 * Central-install orchestrator — the outer ring around the pure seam.
 *
 * runCentralInstall is what the per-agent install hook calls. It holds the
 * global install lock across the ENTIRE read→reconcile→execute section, so the
 * authoritative reconcile runs against fresh on-disk state inside the lock. A
 * plan computed before the lock can be stale (another installer may have won a
 * race and bumped content_version); only the in-lock plan is executed.
 *
 * Layering: this file adds orchestration only. reconcileInstall (pure decision)
 * and executeInstallPlan (effects) are unchanged. Atomicity (temp-file + rename,
 * bytes-before-metadata) is a property of the injected fs seam, defaulting to
 * createAtomicNodeFsSeam.
 */
import path from "node:path";

import { reconcileInstall, executeInstallPlan } from "./reconcile-central-install.js";
import { createAtomicNodeFsSeam, resolveCentralPaths, readCentralState } from "./node-fs-seam.js";
import { acquireInstallLock } from "./install-lock.js";

const INSTALL_LOCK_NAME = "install.lock";

/**
 * @typedef {Object} RunCentralInstallDeps
 * @property {import("./reconcile-central-install.js").FsSeam} [fs]  defaults to atomic node seam
 * @property {import("./install-lock.js").InstallLockOptions} [lock]
 * @property {boolean} [daemonRunning]  pass-through to reconcile's runtime signals
 *
 * @typedef {Object} RunCentralInstallResult
 * @property {import("./reconcile-central-install.js").ReconcilePlan} plan  the in-lock plan that was executed
 * @property {import("./reconcile-central-install.js").ExecutionResult} result
 * @property {boolean} stoleStale  whether a stale lock was reclaimed to proceed
 */

/**
 * Acquire the lock, re-read disk state, reconcile, execute, release.
 *
 * @param {string} stateRoot
 * @param {import("./reconcile-central-install.js").InstallActor} actor
 * @param {RunCentralInstallDeps} [deps]
 * @returns {Promise<RunCentralInstallResult>}
 */
export async function runCentralInstall(stateRoot, actor, deps = {}) {
  const fs = deps.fs ?? createAtomicNodeFsSeam();
  const lockPath = path.join(stateRoot, INSTALL_LOCK_NAME);
  const lock = await acquireInstallLock(lockPath, deps.lock ?? {});
  try {
    // Authoritative reconcile: fresh disk state read INSIDE the lock.
    const state = await readCentralState(stateRoot, actor.comm);
    state.daemonRunning = deps.daemonRunning ?? false;
    const plan = reconcileInstall(actor, state);
    const paths = resolveCentralPaths(stateRoot, actor.comm);
    const result = await executeInstallPlan(plan, actor, paths, fs);
    return { plan, result, stoleStale: lock.stoleStale };
  } finally {
    await lock.release();
  }
}

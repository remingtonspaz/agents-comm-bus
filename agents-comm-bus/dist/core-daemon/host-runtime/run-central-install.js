import path from "node:path";
import { existsSync } from "node:fs";
import { reconcileInstall, executeInstallPlan, installCliLaunchers } from "./reconcile-central-install.js";
import { createAtomicNodeFsSeam, resolveCentralPaths, readCentralState } from "./node-fs-seam.js";
import { acquireInstallLock } from "./install-lock.js";
const INSTALL_LOCK_NAME = "install.lock";
export async function runCentralInstall(stateRoot, actor, deps = {}) {
    const fs = deps.fs ?? createAtomicNodeFsSeam();
    const lockPath = path.join(stateRoot, INSTALL_LOCK_NAME);
    const lock = await acquireInstallLock(lockPath, deps.lock ?? {});
    try {
        const state = await readCentralState(stateRoot, actor.comm);
        state.daemonRunning = deps.daemonRunning ?? false;
        const plan = reconcileInstall(actor, state);
        const paths = resolveCentralPaths(stateRoot, actor.comm);
        const result = await executeInstallPlan(plan, actor, paths, fs);
        if (plan.daemon.writeBundle && actor.pluginInstallDir) {
            const cliSrc = path.join(actor.pluginInstallDir, "cli.bundle.js");
            if (existsSync(cliSrc)) {
                await installCliLaunchers(paths, cliSrc, fs);
                result.wroteBundles.push(paths.cliBundle);
            }
        }
        return { plan, result, stoleStale: lock.stoleStale };
    }
    finally {
        await lock.release();
    }
}
//# sourceMappingURL=run-central-install.js.map
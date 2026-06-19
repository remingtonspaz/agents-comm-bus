import type { InstallActor, FsSeam, ReconcilePlan, ExecutionResult } from "./reconcile-central-install.js";
import type { InstallLockOptions } from "./install-lock.js";
export interface RunCentralInstallDeps {
    fs?: FsSeam;
    lock?: InstallLockOptions;
    daemonRunning?: boolean;
}
export interface RunCentralInstallResult {
    plan: ReconcilePlan;
    result: ExecutionResult;
    stoleStale: boolean;
}
export declare function runCentralInstall(stateRoot: string, actor: InstallActor, deps?: RunCentralInstallDeps): Promise<RunCentralInstallResult>;
//# sourceMappingURL=run-central-install.d.ts.map
import { readFile } from "node:fs/promises";
import { runCentralInstall as defaultRunCentralInstall } from "./run-central-install.js";
import { readCentralState as defaultReadCentralState } from "./node-fs-seam.js";
import type { InstallActor, FsSeam, ReconcilePlan, ExecutionResult } from "./reconcile-central-install.js";
import type { InstallLockOptions } from "./install-lock.js";
export declare const INSTALL_STAMP_NAME = "install-stamp.json";
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
export declare function resolveInstallMode(env: Record<string, string | undefined>): InstallMode;
export declare function readInstallStamp(pluginInstallDir: string | undefined, deps?: EnsureCentralInstallDeps): Promise<InstallStamp | null>;
export declare function ensureCentralInstall(options: EnsureCentralInstallOptions): Promise<EnsureCentralInstallResult>;
export declare function resolveAdapterBundleVersion(stamp: InstallStamp, comm: string): string;
//# sourceMappingURL=ensure-central-install.d.ts.map
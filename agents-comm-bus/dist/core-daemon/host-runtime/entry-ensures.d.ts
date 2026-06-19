import { resolveStatePaths as defaultResolveStatePaths } from "../paths.js";
import { ensureCentralInstall as defaultEnsureCentralInstall } from "./ensure-central-install.js";
import type { EnsureCentralInstallDeps, EnsureCentralInstallResult } from "./ensure-central-install.js";
import type { DevConfigDeps } from "./dev-config-resolver.js";
import type { EnsureDaemonOptions, EnsureDaemonResult } from "../bootstrap/ensure-daemon.js";
export interface EntryContextDeps {
    exists?: (p: string) => boolean;
}
export interface EntryEnsuresDeps {
    ensureDaemon?: (options: EnsureDaemonOptions) => Promise<EnsureDaemonResult>;
    ensureCentralInstall?: typeof defaultEnsureCentralInstall;
    resolveStatePaths?: typeof defaultResolveStatePaths;
    devConfigDeps?: DevConfigDeps;
    centralInstallDeps?: EnsureCentralInstallDeps;
    entryContextDeps?: EntryContextDeps;
}
export interface EntryEnsuresOptions {
    agent: string;
    comm: string;
    stateRoot?: string;
    discoveryRoot?: string;
    /** Caller's own dir; the resolver walks up from here to the dev marker. */
    fromDir?: string;
    projectRoot?: string;
    pluginInstallDir?: string;
    env?: Record<string, string | undefined>;
    ensureDaemonOptions?: Partial<EnsureDaemonOptions>;
    daemonRunning?: boolean;
    readOnlyCentralInstall?: boolean;
    deps?: EntryEnsuresDeps;
}
export interface EntryEnsuresResult extends EnsureDaemonResult {
    centralInstall: EnsureCentralInstallResult;
    stateRoot: string;
    discoveryRoot: string;
    env: Record<string, string | undefined>;
}
export declare function resolveEntryContext(fromDir: string, deps?: EntryContextDeps): {
    projectRoot?: string;
    pluginInstallDir?: string;
};
export declare function entryEnsures(options: EntryEnsuresOptions): Promise<EntryEnsuresResult>;
//# sourceMappingURL=entry-ensures.d.ts.map
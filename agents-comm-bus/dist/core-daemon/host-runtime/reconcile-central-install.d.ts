export type AgentId = "claude" | "codex";
export type ContentKind = "daemon" | "adapter";
export interface InstallActor {
    agent: AgentId;
    comm: string;
    pluginVersion: string;
    daemonBundleVersion: string;
    adapterBundleVersion: string;
    pluginInstallDir?: string;
    daemonSidecars?: string[];
    installedAt: string;
}
export interface ProvenanceEntry {
    agent: AgentId;
    comm: string;
    plugin_version: string;
    bundle_version: string;
    installed_at: string;
}
export interface VersionRecord {
    schema_version: number;
    content_version: string;
    content_kind: ContentKind;
    content_id?: string;
    content_source: ProvenanceEntry;
    installed_by: ProvenanceEntry[];
}
export interface CentralState {
    daemonExists: boolean;
    daemonVersionFile: VersionRecord | null;
    adapterExists: boolean;
    adapterVersionFile: VersionRecord | null;
    daemonRunning: boolean;
}
export interface ArtifactPlan {
    writeBundle: boolean;
    writeVersionFile: boolean;
    contentReplaced: boolean;
    resultingContentVersion: string;
    resultingVersionFile: VersionRecord;
    reasons: string[];
}
export interface ReconcilePlan {
    daemon: ArtifactPlan;
    adapter: ArtifactPlan;
    requiresSpawn: boolean;
    requiresDaemonRestart: boolean;
    requiresAdapterReload: boolean;
    reasons: string[];
}
export interface FsSeam {
    mkdirp: (dir: string) => Promise<void>;
    copyFile: (from: string, to: string) => Promise<void>;
    writeFile: (file: string, data: string) => Promise<void>;
    chmod?: (file: string, mode: number) => Promise<void>;
}
export interface CentralPaths {
    daemonBundle: string;
    daemonVersionFile: string;
    cliBundle: string;
    adapterBundle: string;
    adapterVersionFile: string;
}
export interface ExecutionResult {
    wroteBundles: string[];
    wroteVersionFiles: string[];
}
export declare const VERSION_FILE_SCHEMA = 1;
export declare function reconcileInstall(actor: InstallActor, state: CentralState): ReconcilePlan;
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
export declare function executeInstallPlan(plan: ReconcilePlan, actor: InstallActor, paths: CentralPaths, fs: FsSeam): Promise<ExecutionResult>;
export declare function installCliLaunchers(paths: CentralPaths, cliSrc: string, fs: FsSeam): Promise<void>;
//# sourceMappingURL=reconcile-central-install.d.ts.map
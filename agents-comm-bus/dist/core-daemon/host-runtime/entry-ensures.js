import { existsSync } from "node:fs";
import path from "node:path";
import { ensureDaemon as defaultEnsureDaemon } from "../bootstrap/ensure-daemon.js";
import { resolveStatePaths as defaultResolveStatePaths } from "../paths.js";
import { ensureCentralInstall as defaultEnsureCentralInstall, resolveInstallMode, } from "./ensure-central-install.js";
import { applyDevConfig, DEV_MARKER_NAME } from "./dev-config-resolver.js";
import { INSTALL_STAMP_NAME } from "./ensure-central-install.js";
export function resolveEntryContext(fromDir, deps = {}) {
    const exists = deps.exists ?? existsSync;
    return {
        projectRoot: findAncestorContaining(fromDir, DEV_MARKER_NAME, exists),
        pluginInstallDir: findAncestorContaining(fromDir, INSTALL_STAMP_NAME, exists),
    };
}
function findAncestorContaining(dir, name, exists) {
    let current = path.resolve(dir);
    for (;;) {
        if (exists(path.join(current, name)))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
export async function entryEnsures(options) {
    const { agent, comm, skipCentralInstall = false, stateRoot, discoveryRoot, fromDir, projectRoot, pluginInstallDir, env = process.env, ensureDaemonOptions = {}, daemonRunning = false, readOnlyCentralInstall = false, deps = {}, } = options ?? {};
    const ensureDaemonFn = deps.ensureDaemon ?? defaultEnsureDaemon;
    const ensureCentralInstallFn = deps.ensureCentralInstall ?? defaultEnsureCentralInstall;
    let resolvedProjectRoot = projectRoot;
    let resolvedPluginInstallDir = pluginInstallDir;
    if (fromDir && (resolvedProjectRoot === undefined || resolvedPluginInstallDir === undefined)) {
        const ctx = resolveEntryContext(fromDir, deps.entryContextDeps);
        resolvedProjectRoot = resolvedProjectRoot ?? ctx.projectRoot;
        resolvedPluginInstallDir = resolvedPluginInstallDir ?? ctx.pluginInstallDir;
    }
    const resolvedEnv = resolvedProjectRoot
        ? applyDevConfig(env, resolvedProjectRoot, deps.devConfigDeps).env
        : env;
    const resolveStatePathsFn = deps.resolveStatePaths ?? defaultResolveStatePaths;
    const canonicalStateRoot = stateRoot ??
        resolvedEnv.AGENTS_COMM_BUS_ROOT ??
        resolveStatePathsFn({ stateRoot: resolvedEnv.AGENTS_COMM_BUS_STATE_ROOT }).root;
    const canonicalDiscoveryRoot = ensureDaemonOptions.discoveryRoot ??
        discoveryRoot ??
        resolvedEnv.AGENTS_COMM_BUS_DISCOVERY_ROOT ??
        canonicalStateRoot;
    // AGE-63: daemon-resolution-only mode skips central-install entirely (Pi core;
    // per-comm extensions own their own comm's central-install). Without the flag,
    // behavior is unchanged — a missing `comm` still reaches ensureCentralInstall,
    // which infers it from the install stamp (the Claude/Codex host callers).
    const centralInstall = skipCentralInstall
        ? { mode: resolveInstallMode(resolvedEnv), skipped: true }
        : await ensureCentralInstallFn({
            stateRoot: canonicalStateRoot,
            agent,
            comm,
            pluginInstallDir: resolvedPluginInstallDir,
            env: resolvedEnv,
            daemonRunning,
            readOnlyIfCentralInstalled: readOnlyCentralInstall,
            deps: deps.centralInstallDeps,
        });
    const daemon = await ensureDaemonFn({
        ...ensureDaemonOptions,
        stateRoot: canonicalStateRoot,
        discoveryRoot: canonicalDiscoveryRoot,
        env: {
            ...resolvedEnv,
            AGENTS_COMM_BUS_DISCOVERY_ROOT: canonicalDiscoveryRoot,
        },
    });
    return {
        ...daemon,
        centralInstall,
        stateRoot: canonicalStateRoot,
        discoveryRoot: canonicalDiscoveryRoot,
        env: {
            ...resolvedEnv,
            AGENTS_COMM_BUS_DISCOVERY_ROOT: canonicalDiscoveryRoot,
        },
    };
}
//# sourceMappingURL=entry-ensures.js.map
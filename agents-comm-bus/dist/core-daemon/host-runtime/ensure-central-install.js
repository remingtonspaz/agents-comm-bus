import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { runCentralInstall as defaultRunCentralInstall } from "./run-central-install.js";
import { readCentralState as defaultReadCentralState } from "./node-fs-seam.js";
import { stripBom } from "./strip-bom.js";
export const INSTALL_STAMP_NAME = "install-stamp.json";
export function resolveInstallMode(env) {
    return env && env.AGENTS_COMM_BUS_BIN ? "source" : "production";
}
export async function readInstallStamp(pluginInstallDir, deps = {}) {
    if (!pluginInstallDir)
        return null;
    const read = deps.readFile ?? readFile;
    try {
        const raw = await read(path.join(pluginInstallDir, INSTALL_STAMP_NAME), "utf8");
        const parsed = JSON.parse(stripBom(raw));
        if (!parsed ||
            parsed.schema_version !== 1 ||
            typeof parsed.plugin_version !== "string" ||
            typeof parsed.daemon_bundle_version !== "string" ||
            typeof parsed.adapter_bundle_version !== "string" ||
            !isValidAdapterBundleVersionsMap(parsed.adapter_bundle_versions)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
export async function ensureCentralInstall(options) {
    const env = options.env ?? process.env;
    const mode = resolveInstallMode(env);
    if (mode === "source") {
        return { mode: "source", skipped: true };
    }
    const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
    if (!options.pluginInstallDir || !stamp) {
        if (options.stateRoot && existsSync(path.join(options.stateRoot, "bin", "daemon.js"))) {
            return { mode: "production", skipped: true };
        }
        throw new Error(`central install (production mode): missing or invalid plugin install metadata.\n` +
            `  - no source-mode signal (no AGENTS_COMM_BUS_BIN, no .agents-comm-bus-dev.json marker resolved)\n` +
            `  - no valid packaged install artifact (expected ${INSTALL_STAMP_NAME} under ` +
            `pluginInstallDir=${options.pluginInstallDir ?? "<unset>"})\n` +
            `Fix one of:\n` +
            `  - source/dev checkout: create .agents-comm-bus-dev.json at the repo root ` +
            `(see .agents-comm-bus-dev.json.example), or set AGENTS_COMM_BUS_BIN\n` +
            `  - packaged install: provide the staged plugin artifacts incl. ${INSTALL_STAMP_NAME}`);
    }
    const resolvedAgent = options.agent ?? stamp.agent;
    const resolvedComm = options.comm ?? stamp.comm;
    const resolvedAdapterBundleVersion = resolveAdapterBundleVersion(stamp, resolvedComm ?? "");
    if (typeof resolvedAgent !== "string" ||
        resolvedAgent.length === 0 ||
        typeof resolvedComm !== "string" ||
        resolvedComm.length === 0) {
        throw new Error(`central install (production mode): install stamp resolved an invalid actor identity ` +
            `(agent=${JSON.stringify(resolvedAgent)}, comm=${JSON.stringify(resolvedComm)}). ` +
            `The stamp must carry agent + comm, or the caller must supply them.`);
    }
    const actor = {
        agent: resolvedAgent,
        comm: resolvedComm,
        pluginVersion: stamp.plugin_version,
        daemonBundleVersion: stamp.daemon_bundle_version,
        adapterBundleVersion: resolvedAdapterBundleVersion,
        pluginInstallDir: options.pluginInstallDir,
        installedAt: options.installedAt ?? new Date().toISOString(),
        ...(Array.isArray(stamp.daemon_sidecars) ? { daemonSidecars: stamp.daemon_sidecars } : {}),
    };
    if (await centralInstallContentIsCurrent(options.stateRoot, resolvedComm, stamp, resolvedAdapterBundleVersion, options.deps)) {
        return { mode: "production", actor, skipped: true };
    }
    if (options.readOnlyIfCentralInstalled &&
        (await centralInstallHasRunnableContent(options.stateRoot, resolvedComm, options.deps))) {
        return { mode: "production", actor, skipped: true };
    }
    const run = options.deps?.runCentralInstall ?? defaultRunCentralInstall;
    const outcome = await run(options.stateRoot, actor, {
        fs: options.deps?.fs,
        lock: options.lock,
        daemonRunning: options.daemonRunning ?? false,
    });
    return { mode: "production", actor, ...outcome };
}
async function centralInstallContentIsCurrent(stateRoot, comm, stamp, adapterBundleVersion, deps = {}) {
    const readState = deps.readCentralState ?? defaultReadCentralState;
    try {
        const state = await readState(stateRoot, comm);
        return Boolean(state.daemonExists &&
            state.adapterExists &&
            state.daemonVersionFile?.content_version === stamp.daemon_bundle_version &&
            state.adapterVersionFile?.content_version === adapterBundleVersion);
    }
    catch {
        return false;
    }
}
export function resolveAdapterBundleVersion(stamp, comm) {
    const fromMap = stamp.adapter_bundle_versions?.[comm];
    if (typeof fromMap === "string" && fromMap.length > 0) {
        return fromMap;
    }
    return stamp.adapter_bundle_version;
}
function isValidAdapterBundleVersionsMap(value) {
    if (value === undefined)
        return true;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    return Object.entries(value).every(([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0);
}
async function centralInstallHasRunnableContent(stateRoot, comm, deps = {}) {
    const readState = deps.readCentralState ?? defaultReadCentralState;
    try {
        const state = await readState(stateRoot, comm);
        return Boolean(state.daemonExists && state.adapterExists);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=ensure-central-install.js.map
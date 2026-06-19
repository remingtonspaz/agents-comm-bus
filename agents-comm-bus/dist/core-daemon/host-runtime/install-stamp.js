export const INSTALL_STAMP_SCHEMA = 1;
export function buildInstallStamp(fields) {
    const { agent, comm, pluginVersion, daemonBundleVersion, adapterBundleVersion, adapterBundleVersions, daemonSidecars, } = fields ?? {};
    requireString("agent", agent);
    requireString("comm", comm);
    requireString("pluginVersion", pluginVersion);
    requireString("daemonBundleVersion", daemonBundleVersion);
    requireString("adapterBundleVersion", adapterBundleVersion);
    const versionsMap = adapterBundleVersions ?? { [comm]: adapterBundleVersion };
    if (typeof versionsMap !== "object" ||
        versionsMap === null ||
        Object.entries(versionsMap).some(([k, v]) => typeof k !== "string" || typeof v !== "string" || v.length === 0)) {
        throw new Error("buildInstallStamp: adapterBundleVersions must be a non-empty string→string map");
    }
    if (typeof versionsMap[comm] !== "string" || versionsMap[comm] !== adapterBundleVersion) {
        throw new Error("buildInstallStamp: adapterBundleVersions must include the stamped comm with the same version as adapterBundleVersion");
    }
    const stamp = {
        schema_version: INSTALL_STAMP_SCHEMA,
        agent,
        comm,
        plugin_version: pluginVersion,
        daemon_bundle_version: daemonBundleVersion,
        adapter_bundle_version: adapterBundleVersion,
        adapter_bundle_versions: { ...versionsMap },
    };
    if (daemonSidecars !== undefined) {
        if (!Array.isArray(daemonSidecars) || daemonSidecars.some((s) => typeof s !== "string")) {
            throw new Error("buildInstallStamp: daemonSidecars must be an array of strings");
        }
        stamp.daemon_sidecars = [...daemonSidecars];
    }
    return stamp;
}
function requireString(name, value) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`buildInstallStamp: ${name} must be a non-empty string`);
    }
}
//# sourceMappingURL=install-stamp.js.map
export declare const INSTALL_STAMP_SCHEMA = 1;
export interface BuildInstallStampFields {
    agent: string;
    comm: string;
    pluginVersion: string;
    daemonBundleVersion: string;
    adapterBundleVersion: string;
    adapterBundleVersions?: Record<string, string>;
    daemonSidecars?: string[];
}
export interface InstallStampObject {
    schema_version: number;
    agent: string;
    comm: string;
    plugin_version: string;
    daemon_bundle_version: string;
    adapter_bundle_version: string;
    adapter_bundle_versions: Record<string, string>;
    daemon_sidecars?: string[];
}
export declare function buildInstallStamp(fields: BuildInstallStampFields): InstallStampObject;
//# sourceMappingURL=install-stamp.d.ts.map
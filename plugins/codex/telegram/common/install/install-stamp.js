/**
 * Build the central-install stamp object that the stage scripts write to
 * `install-stamp.json` in each plugin artifact, and that
 * `ensure-central-install.js → readInstallStamp` consumes.
 *
 * The three version fields come from three INDEPENDENT sources — the plugin
 * manifest (`plugin_version`), `DAEMON_VERSION` (`daemon_bundle_version`), and
 * the per-comm `ADAPTER_VERSION` (`adapter_bundle_version`). Keeping them
 * separate is the whole point: a plugin-version bump must never masquerade as
 * an adapter/daemon content change (the conflation the central-install
 * downgrade guards exist to prevent). This builder takes them as distinct
 * arguments and never derives one from another.
 *
 * All three are required non-empty strings, matching readInstallStamp's strict
 * validation (schema_version === 1 + the three version strings). A plugin
 * manifest that lacks a `version` therefore fails loud at stage time rather
 * than producing a stamp the reader would reject.
 */
export const INSTALL_STAMP_SCHEMA = 1;

/**
 * @param {Object} fields
 * @param {string} fields.agent
 * @param {string} fields.comm
 * @param {string} fields.pluginVersion        provenance (from the plugin manifest)
 * @param {string} fields.daemonBundleVersion   content key (DAEMON_VERSION)
 * @param {string} fields.adapterBundleVersion  content key (per-comm ADAPTER_VERSION)
 * @returns {{schema_version:number, agent:string, comm:string, plugin_version:string, daemon_bundle_version:string, adapter_bundle_version:string}}
 */
export function buildInstallStamp(fields) {
  const { agent, comm, pluginVersion, daemonBundleVersion, adapterBundleVersion } = fields ?? {};
  requireString("agent", agent);
  requireString("comm", comm);
  requireString("pluginVersion", pluginVersion);
  requireString("daemonBundleVersion", daemonBundleVersion);
  requireString("adapterBundleVersion", adapterBundleVersion);
  return {
    schema_version: INSTALL_STAMP_SCHEMA,
    agent,
    comm,
    plugin_version: pluginVersion,
    daemon_bundle_version: daemonBundleVersion,
    adapter_bundle_version: adapterBundleVersion,
  };
}

/** @param {string} name @param {unknown} value */
function requireString(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`buildInstallStamp: ${name} must be a non-empty string`);
  }
}

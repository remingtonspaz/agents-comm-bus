/**
 * Telegram adapter bundle version.
 *
 * This is an INDEPENDENT content-version source for the Telegram CommAdapter —
 * deliberately separate from the daemon version (`DAEMON_VERSION`) and the
 * plugin package version. The central-install stamp (`install-stamp.json`)
 * records `adapter_bundle_version` from here so adapter-only changes can bump
 * independently of the daemon, and so a plugin-version bump never masquerades
 * as an adapter content change (the conflation the stamp's three-field
 * separation exists to prevent).
 *
 * Bump this when the Telegram adapter's shipped behavior changes. Version bump
 * policy can be formalized later; the invariant is that this is its own named
 * source, never derived from plugin_version or DAEMON_VERSION.
 */
export declare const ADAPTER_VERSION = "0.1.1";
//# sourceMappingURL=version.d.ts.map
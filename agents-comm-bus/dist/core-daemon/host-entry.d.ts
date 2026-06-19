/**
 * AGE-61 — host-runtime package export.
 *
 * Public package entry point that any external host package (notably the Pi
 * extension, which ships outside this monorepo's `hosts/` tree) imports to
 * reach the shared dev/prod daemon-resolution seam:
 *
 *   import { entryEnsures } from "agents-comm-bus/host-entry";
 *
 * Re-exports the real implementation from `host-runtime/` (package-owned; no
 * `hosts/` reachback).
 */
export { entryEnsures, resolveEntryContext, type EntryEnsuresOptions, type EntryEnsuresResult, type EntryEnsuresDeps, type EntryContextDeps, } from "./host-runtime/entry-ensures.js";
//# sourceMappingURL=host-entry.d.ts.map
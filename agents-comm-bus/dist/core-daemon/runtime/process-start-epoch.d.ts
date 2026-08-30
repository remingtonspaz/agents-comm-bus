export interface ProcessStartIdentityOptions {
    readProcStat?: (pid: number) => string | null;
    readBootId?: () => string | null;
    readProcUptime?: () => string | null;
    readClockTicksPerSec?: () => number | null;
}
/**
 * Stable per-process identity for liveness (stored on session rows).
 * Linux: FNV hash of boot_id + starttime ticks (no Date.now drift).
 * Windows/Darwin: stable epoch ms from OS APIs.
 */
export declare function readProcessStartIdentity(pid: number, options?: ProcessStartIdentityOptions): number | null;
/** @deprecated alias — use readProcessStartIdentity */
export declare function readProcessStartEpochMs(pid: number, options?: ProcessStartIdentityOptions): number | null;
export declare function processStartIdentityMatches(stored: number, pid: number, options?: ProcessStartIdentityOptions): boolean;
/** Definite mismatch vs inconclusive (probe unavailable / no stored identity). */
export type ProcessStartIdentityCompare = "match" | "mismatch" | "inconclusive";
/**
 * Compare stored process-start identity to the live pid probe.
 * Inconclusive when either side is unavailable — callers must not treat that as dead.
 */
export declare function compareProcessStartIdentity(stored: number | null | undefined, pid: number, options?: ProcessStartIdentityOptions): ProcessStartIdentityCompare;
/** Boot epoch for the current process — stable for this process lifetime. */
export declare function currentProcessStartEpochMs(): number;
//# sourceMappingURL=process-start-epoch.d.ts.map
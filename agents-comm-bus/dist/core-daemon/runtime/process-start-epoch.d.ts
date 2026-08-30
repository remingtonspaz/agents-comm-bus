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
/** Boot epoch for the current process — stable for this process lifetime. */
export declare function currentProcessStartEpochMs(): number;
//# sourceMappingURL=process-start-epoch.d.ts.map
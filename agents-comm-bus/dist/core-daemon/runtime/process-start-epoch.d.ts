export interface ProcessStartIdentityOptions {
    readProcStat?: (pid: number) => string | null;
    readBootId?: () => string | null;
    readProcUptime?: () => string | null;
    readClockTicksPerSec?: () => number | null;
}
/** Bounded, injectable cache. Expired entries are inconclusive, never stale evidence. */
export declare function createProcessStartIdentityCache(probe: (pids: number[]) => Promise<ReadonlyMap<number, number | null>>, now?: () => number, ttlMs?: number, selfPid?: number): {
    read(pid: number): number | null;
    prefetch: (pids: readonly number[], refresh?: boolean) => Promise<void>;
    reset(): void;
};
export declare function probeProcessIdentities(pids: number[], platform?: NodeJS.Platform, run?: (file: string, args: string[]) => Promise<string>): Promise<Map<number, number | null>>;
export declare function prefetchProcessStartIdentity(pids: readonly number[]): Promise<void>;
export declare function __resetProcessStartIdentityCacheForTests(): void;
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
export declare function currentProcessStartEpochMs(): number;
//# sourceMappingURL=process-start-epoch.d.ts.map
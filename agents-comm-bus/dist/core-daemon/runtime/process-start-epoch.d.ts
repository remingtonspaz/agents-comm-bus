/**
 * Best-effort process creation epoch (ms). Used for AGE-101 pid+start-time
 * liveness; returns null when the platform cannot resolve the stamp.
 */
export declare function readProcessStartEpochMs(pid: number, options?: {
    readProcStat?: (pid: number) => string | null;
}): number | null;
/** Boot epoch for the current process — stable for this process lifetime. */
export declare function currentProcessStartEpochMs(): number;
//# sourceMappingURL=process-start-epoch.d.ts.map
import type { RetirementBlockerSnapshot } from "./agent-bridge.js";
/** Default continuous-idle grace before a stray daemon self-retires (AGE-36). */
export declare const DEFAULT_IDLE_REAPER_GRACE_MS = 90000;
export declare const DEFAULT_IDLE_REAPER_INTERVAL_MS = 5000;
export interface IdleReaperBlockerSnapshot {
    held_leases: number;
    live_ipc_connections: number;
    pending_inbound: number;
    in_flight_adapters: number;
    bridge_blockers: Record<string, RetirementBlockerSnapshot>;
    /** Diagnostic: whether IPC has been quiet for at least the grace window. */
    ipc_quiet_for_grace: boolean;
}
export interface IdleReaperSampleInput {
    now: number;
    lastIpcServedAt: number;
    graceMs: number;
    heldLeaseCount: () => number;
    liveIpcConnectionCount: () => number;
    pendingInboundLength: () => number;
    inFlightAdapterCount: () => number;
    bridgeBlockers: () => Record<string, RetirementBlockerSnapshot | null>;
}
export interface IdleReaperSampleResult {
    structurallyEligible: boolean;
    blockers: IdleReaperBlockerSnapshot;
    reasons: string[];
}
/**
 * Pure structural eligibility — runtime-local blockers only. IPC recency is
 * evaluated separately so retirement needs one grace after structural clearance
 * AND IPC quiet, not ~2x grace from last activity.
 */
export declare function sampleStructuralEligibility(input: IdleReaperSampleInput): IdleReaperSampleResult;
/** @deprecated Use sampleStructuralEligibility — kept for transitional imports. */
export declare function sampleIdleReaperEligibility(input: IdleReaperSampleInput): IdleReaperSampleResult & {
    eligible: boolean;
};
export declare function shouldIdleReaperRetire(input: {
    now: number;
    graceMs: number;
    structuralEligibleSince: number | null;
    lastIpcServedAt: number;
    structurallyEligible: boolean;
}): boolean;
export interface StartIdleReaperOptions {
    graceMs?: number;
    intervalMs?: number;
    now?: () => number;
    lastIpcServedAt: () => number;
    heldLeaseCount: () => number;
    liveIpcConnectionCount: () => number;
    pendingInboundLength: () => number;
    inFlightAdapterCount: () => number;
    bridgeBlockers: () => Record<string, RetirementBlockerSnapshot | null>;
    retire: () => void | Promise<void>;
    log?: (message: string) => void;
    setIntervalFn?: (fn: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    initialDelayMs?: number;
}
export interface IdleReaperHandle {
    stop(): void;
}
export declare function startIdleReaper(options: StartIdleReaperOptions): IdleReaperHandle;
//# sourceMappingURL=daemon-idle-reaper.d.ts.map
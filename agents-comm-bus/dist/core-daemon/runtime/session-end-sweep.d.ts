import type { Session, SessionEndObservation, Storage } from "agents-comm-bus-core";
import { classifySessionOwnerProcess, type SessionOwnerLivenessOptions } from "./session-owner-liveness.js";
/** Default periodic sweep interval — boot-only is insufficient for long-lived daemons. */
export declare const DEFAULT_SESSION_END_SWEEP_INTERVAL_MS: number;
export interface SessionEndSweepCounts {
    ended: number;
    kept_live: number;
    kept_stale: number;
    kept_no_owner_leased: number;
    cas_lost: number;
}
export declare function sessionEndObservation(session: Session): SessionEndObservation;
/**
 * Whether the periodic sweep may end this active session. Age alone never ends;
 * stale-but-alive owners are kept even when a lease is held.
 */
export declare function shouldSweepEndSession(session: Pick<Session, "lease_holder_connection_id"> & Parameters<typeof classifySessionOwnerProcess>[0], options?: SessionOwnerLivenessOptions): boolean;
export declare function runSessionEndSweep(input: {
    storage: Storage;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    recencyMs?: number;
    log?: (message: string) => void;
}): Promise<SessionEndSweepCounts>;
export interface SessionEndSweepHandle {
    stop(): void;
}
export declare function startSessionEndSweep(options: {
    storage: Storage;
    intervalMs?: number;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    recencyMs?: number;
    log?: (message: string) => void;
    setIntervalFn?: (fn: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    /** Run one sweep immediately on start (daemon boot). */
    runOnStart?: boolean;
}): SessionEndSweepHandle;
//# sourceMappingURL=session-end-sweep.d.ts.map
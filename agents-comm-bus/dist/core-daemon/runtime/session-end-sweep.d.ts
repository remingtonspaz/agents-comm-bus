import type { Session, SessionEndObservation, Storage } from "agents-comm-bus-core";
import { classifySessionOwnerProcess, type SessionOwnerLivenessOptions } from "./session-owner-liveness.js";
import type { ScopeReleaseReconcileCounts, ScopeReleaseReconcileState } from "./scope-release-reconcile.js";
import { reconcileLazyAdapterScopes } from "./scope-release-reconcile.js";
/** Default periodic sweep interval — boot-only is insufficient for long-lived daemons. */
export declare const DEFAULT_SESSION_END_SWEEP_INTERVAL_MS: number;
export interface SessionEndSweepCounts {
    ended: number;
    kept_live: number;
    kept_stale: number;
    kept_no_owner_leased: number;
    cas_lost: number;
    reconcile?: ScopeReleaseReconcileCounts;
}
export type SessionScopeReconcileInput = Parameters<typeof reconcileLazyAdapterScopes>[0];
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
    /** Row-ender classification injectables (start-probe, recency, pid liveness). */
    ownerLivenessOptions?: SessionOwnerLivenessOptions;
    log?: (message: string) => void;
    /** Test hook: hold the sweep in-flight until released (session-end pass only). */
    sweepHold?: () => Promise<void>;
    /** AGE-101: lazy adapter scope reconciliation after session-end pass. */
    reconcile?: Omit<SessionScopeReconcileInput, "now">;
}): Promise<SessionEndSweepCounts>;
export interface SessionEndSweepHandle {
    stop(): void;
    /** AGE-101: explicit session-exit hint — next sweep reconciles without grace. */
    requestEarlyReconcile(): void;
}
export declare function startSessionEndSweep(options: {
    storage: Storage;
    intervalMs?: number;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    recencyMs?: number;
    ownerLivenessOptions?: SessionOwnerLivenessOptions;
    log?: (message: string) => void;
    sweepHold?: () => Promise<void>;
    reconcile?: Omit<SessionScopeReconcileInput, "now" | "graceMs" | "scheduleGraceExpiry" | "cancelGraceExpiry">;
    reconcileState?: ScopeReleaseReconcileState;
    setIntervalFn?: (fn: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    /** Run one sweep immediately on start (daemon boot). */
    runOnStart?: boolean;
}): SessionEndSweepHandle;
//# sourceMappingURL=session-end-sweep.d.ts.map
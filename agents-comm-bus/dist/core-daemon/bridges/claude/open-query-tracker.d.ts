import type { QueryId, SessionId } from "agents-comm-bus-core";
import type { RetirementBlockerSnapshot } from "../../runtime/agent-bridge.js";
export interface OpenQueryTrackerOptions {
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
}
/**
 * Daemon-local open-query inventory for Claude retirement eligibility (AGE-36).
 * Tracks query ids only after a successful bus.openQuery; clears on resolve,
 * supersede, send-cancel, and TTL expiry.
 */
export declare class ClaudeOpenQueryTracker {
    private readonly openQueriesBySession;
    private readonly querySessions;
    private readonly queryTtlTimers;
    private readonly setTimeoutFn;
    private readonly clearTimeoutFn;
    constructor(options?: OpenQueryTrackerOptions);
    openQueryCount(): number;
    getRetirementBlockers(): RetirementBlockerSnapshot | null;
    trackOpenQuery(session: SessionId, queryId: QueryId, ttlSeconds: number): void;
    clearOpenQuery(queryId: QueryId): void;
    clearOpenQueriesForSession(session: SessionId): void;
}
//# sourceMappingURL=open-query-tracker.d.ts.map
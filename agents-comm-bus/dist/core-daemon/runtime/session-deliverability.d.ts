import type { SessionOwnerLiveness, SessionOwnerRecord } from "./session-owner-liveness.js";
/**
 * AGE-89: whether a session can receive daemon-initiated wake delivery —
 * verified owner liveness plus a daemon-local wake route. Pending-queue state
 * is intentionally excluded; deliverability is a route/owner predicate only.
 */
export declare function isSessionLocallyDeliverable(session: SessionOwnerRecord, hasDaemonLocalWakeRoute: boolean, sessionOwnerIsLive: SessionOwnerLiveness): boolean;
//# sourceMappingURL=session-deliverability.d.ts.map
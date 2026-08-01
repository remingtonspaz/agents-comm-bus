import type {
  SessionOwnerLiveness,
  SessionOwnerRecord,
} from "./session-owner-liveness.js";

/**
 * AGE-89: whether a session can receive daemon-initiated wake delivery —
 * verified owner liveness plus a daemon-local wake route. Pending-queue state
 * is intentionally excluded; deliverability is a route/owner predicate only.
 */
export function isSessionLocallyDeliverable(
  session: SessionOwnerRecord,
  hasDaemonLocalWakeRoute: boolean,
  sessionOwnerIsLive: SessionOwnerLiveness,
): boolean {
  return hasDaemonLocalWakeRoute && sessionOwnerIsLive(session);
}

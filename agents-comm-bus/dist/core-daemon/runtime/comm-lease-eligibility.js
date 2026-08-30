import { normalizeDaemonRootPath } from "../paths.js";
import { filterRegistrationsForSession, } from "../session-label-scope.js";
function classifySessionDaemonOwner(session, currentDiscoveryRoot) {
    const stamped = session.lease_owner_daemon_discovery_root;
    if (stamped == null || stamped.length === 0)
        return "missing";
    return normalizeDaemonRootPath(stamped) === normalizeDaemonRootPath(currentDiscoveryRoot)
        ? "match"
        : "foreign";
}
/**
 * AGE-101: pure discovery-root eligibility for live comm-lease acquire/reclaim.
 * Fail-closed on ambiguous/missing daemon-owner stamps on live owning sessions.
 */
export function computeCommLeaseEligibility(input) {
    const scopeSessions = input.sessions.filter((session) => session.status === "active");
    const liveSessions = scopeSessions.filter((session) => input.sessionOwnerIsLive(session));
    if (liveSessions.length === 0)
        return true;
    const owningSessions = liveSessions.filter((session) => {
        const regs = filterRegistrationsForSession([input.registration], session, scopeSessions, input.sessionOwnerIsLive);
        return regs.length > 0;
    });
    if (owningSessions.length === 0)
        return true;
    for (const session of owningSessions) {
        const ownerClass = classifySessionDaemonOwner(session, input.discoveryRoot);
        if (ownerClass !== "match")
            return false;
    }
    return true;
}
//# sourceMappingURL=comm-lease-eligibility.js.map
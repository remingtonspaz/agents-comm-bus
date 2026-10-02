import { normalizeProjectPath } from "../project-path.js";
import { resolveSessionForConversation } from "../session-label-scope.js";
import { sessionEndObservation } from "./session-end-sweep.js";
/** Codex/Pi inbound selection: prefer sessions holding a connection lease. */
export function sessionLeaseHeld(session) {
    return session.lease_holder_connection_id != null;
}
function pickScopeMatchedSession(pool, conversation) {
    if (pool.length === 0)
        return undefined;
    if (!conversation)
        return pool[0];
    const match = resolveSessionForConversation(pool, conversation, (sess) => sess.session_id);
    if (match)
        return match;
    if (!conversation)
        return undefined;
    // Legacy project-only wake dir: unrelated labeled rows must not veto this fallback.
    return pool.find((session) => session.account_label_scope == null);
}
/**
 * Storage-first inbound wake target: preferred tier, then herdr identity, then legacy.
 * Claude passes owner liveness; Codex/Pi pass {@link sessionLeaseHeld}.
 */
export async function selectActiveSessionForInboundWake(storage, project, agent, conversation, isPreferredTier) {
    const resolved = normalizeProjectPath(project);
    const sessions = await storage.listSessions({
        project: resolved,
        agent,
        status: "active",
    });
    if (sessions.length === 0)
        return null;
    const preferred = sessions.filter(isPreferredTier);
    const herdr = sessions.filter((session) => !isPreferredTier(session) && session.wake_identity != null);
    const legacy = sessions.filter((session) => !isPreferredTier(session) && session.wake_identity == null);
    for (const tier of [preferred, herdr, legacy]) {
        const picked = pickScopeMatchedSession(tier, conversation);
        if (picked)
            return picked;
    }
    return null;
}
function scopesMatch(a, b) {
    if (a.account_label_scope == null && b.account_label_scope == null)
        return true;
    return a.account_label_scope === b.account_label_scope;
}
/** End stale unleased siblings when a herdr session is registered for the same scope. */
export async function supersedeStaleSessionsOnHerdrRegister(storage, herdrSession, sessionOwnerIsLive, now = Date.now()) {
    const sessions = await storage.listSessions({
        project: herdrSession.project,
        agent: herdrSession.agent,
        status: "active",
    });
    for (const row of sessions) {
        if (row.session_id === herdrSession.session_id)
            continue;
        if (!scopesMatch(row, herdrSession))
            continue;
        if (sessionOwnerIsLive(row))
            continue;
        if (row.lease_holder_connection_id != null)
            continue;
        await storage.endSessionIfUnchanged(row.session_id, sessionEndObservation(row), now);
    }
}
//# sourceMappingURL=wake-target-selection.js.map
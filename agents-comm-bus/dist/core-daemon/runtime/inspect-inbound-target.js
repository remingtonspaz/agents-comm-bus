/**
 * AGE-91: conservative, read-only resolution of "who is this conversation for,
 * and can this daemon deliver to it right now?"
 *
 * The verdict here is **authoritative over liveness and route state — not over
 * what the delivery path will actually do.** Legacy routing
 * (`resolveSessionForConversation`) silently picks the first labeled match when
 * several match, and Claude hydration deliberately falls back among unlabeled
 * sessions that share a wake directory. Inspection is deliberately *stricter*:
 * more than one live candidate is reported as `ambiguous` and fails closed.
 *
 * That divergence is a feature, not a defect to reconcile. Where inspection
 * says `ambiguous` and routing quietly delivers to `[0]`, the disagreement is
 * diagnostic information *about routing* — a state routing currently tolerates
 * in silence. AGE-91 does not change delivery behavior.
 */
import { classifySessionOwnerProcess } from "./session-owner-liveness.js";
import { isSessionLocallyDeliverable } from "./session-deliverability.js";
import { registrationMatchesConversationScope } from "../session-label-scope.js";
/**
 * Resolve a conversation to at most one session, preserving ambiguity instead
 * of collapsing it.
 *
 * Only sessions the owner-liveness predicate accepts are candidates: two dead
 * rows matching the same scope is not ambiguity anyone can act on.
 */
export function resolveSessionForConversationDetailed(sessions, conversation, sessionOwnerIsLive) {
    const live = sessions.filter((sess) => sessionOwnerIsLive(sess));
    const labeled = live.filter((sess) => sess.account_label_scope != null &&
        registrationMatchesConversationScope(sess.account_label_scope, conversation));
    if (labeled.length === 1) {
        return { resolution: "resolved", session: labeled[0], candidates: [] };
    }
    if (labeled.length > 1) {
        // Legacy routing takes labeled[0] here. Inspection refuses to guess.
        return { resolution: "ambiguous", candidates: labeled };
    }
    const unlabeled = live.filter((sess) => sess.account_label_scope == null);
    if (unlabeled.length === 1) {
        return { resolution: "resolved", session: unlabeled[0], candidates: [] };
    }
    if (unlabeled.length > 1) {
        // Claude hydration may fall back among these because they share a wake
        // directory; inspection reports the ambiguity that fallback conceals.
        return { resolution: "ambiguous", candidates: unlabeled };
    }
    return { resolution: "cold", candidates: [] };
}
function normalizeDaemonRoot(value) {
    return (value ?? "").split("\\").join("/").replace(/\/+$/, "").toLowerCase();
}
/**
 * Read-only. Performs no writes, no CAS, and no lease mutation.
 */
export async function handleInspectInboundTarget(params, deps) {
    const conversation = await resolveConversation(params, deps.storage);
    if (!conversation) {
        return { resolution: "not_found", locally_deliverable: false };
    }
    const registration = {
        project: conversation.project,
        agent: conversation.agent,
        comm: conversation.comm,
        account: conversation.bot_user_id,
        account_label: conversation.account_label,
    };
    const sessions = await deps.storage.listSessions({
        project: conversation.project,
        agent: conversation.agent,
        status: "active",
    });
    const detailed = resolveSessionForConversationDetailed(sessions, { comm: conversation.comm, account_label: conversation.account_label }, deps.sessionOwnerIsLive);
    if (detailed.resolution !== "resolved" || !detailed.session) {
        return {
            resolution: detailed.resolution,
            registration,
            routed_session: null,
            locally_deliverable: false,
            // Diagnostic only, and only for `ambiguous`. A caller that branches on
            // these is doing routing, and routing is daemon-owned.
            candidate_sessions: detailed.candidates.map((c) => ({
                session_id: c.session_id,
                account_label_scope: c.account_label_scope,
            })),
        };
    }
    const session = detailed.session;
    const bridge = deps.bridges.find((b) => b.agentId === conversation.agent);
    const ownerDaemonMatches = normalizeDaemonRoot(session.lease_owner_daemon_discovery_root) ===
        normalizeDaemonRoot(deps.daemonOwner.discoveryRoot);
    // A bridge with no `routeReady` cannot prove a route; fail closed rather than
    // assume one (uncertain → false, the safe-redundant direction).
    const routeReady = ownerDaemonMatches && bridge?.routeReady !== undefined
        ? bridge.routeReady(session.session_id)
        : false;
    return {
        resolution: "resolved",
        registration,
        routed_session: {
            session_id: session.session_id,
            account_label_scope: session.account_label_scope,
            owner_pid: session.lease_owner_process_pid ?? null,
            owner_registered_at: session.lease_owner_process_registered_at ?? null,
            // Process-owner classification ONLY — diagnostics. Not the verdict:
            // the canonical predicate is an OR with the connection lease, so a live
            // connection with no PID is `no_owner` here and still deliverable.
            owner_state: classifySessionOwnerProcess(session),
            owner_daemon_matches: ownerDaemonMatches,
            route_ready: routeReady,
        },
        locally_deliverable: isSessionLocallyDeliverable(session, routeReady, deps.sessionOwnerIsLive),
        candidate_sessions: [],
    };
}
async function resolveConversation(params, storage) {
    const conversationId = params.conversation_id;
    if (typeof conversationId === "string" && conversationId.length > 0) {
        return (await storage.getConversation(conversationId)) ?? undefined;
    }
    // Alternate lookup: (comm, account) is unique per registration. It is an
    // input, never an identity — a slot may span comms.
    const comm = params.comm;
    const account = params.account;
    if (typeof comm !== "string" || typeof account !== "string")
        return undefined;
    const all = await storage.listConversations({ comm: comm, limit: 1000 });
    return all.find((c) => c.bot_user_id === account);
}
//# sourceMappingURL=inspect-inbound-target.js.map
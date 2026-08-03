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
import type { Storage } from "agents-comm-bus-core";
import type { AgentBridge, DaemonSelfIdentity } from "./agent-bridge.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
/** Outcome of resolving a conversation to a session. */
export type InboundTargetResolution = "resolved" | "cold" | "ambiguous" | "not_found";
export interface InspectableSession {
    session_id: string;
    project: string;
    agent: string;
    account_label_scope: string | null;
}
export interface DetailedSessionResolution<T> {
    resolution: Extract<InboundTargetResolution, "resolved" | "cold" | "ambiguous">;
    /** Set only when `resolution === "resolved"`. */
    session?: T;
    /**
     * Diagnostic only, and populated only when `resolution === "ambiguous"`.
     * A consumer that branches on candidates is doing routing, and routing is
     * daemon-owned.
     */
    candidates: readonly T[];
}
/**
 * Resolve a conversation to at most one session, preserving ambiguity instead
 * of collapsing it.
 *
 * Only sessions the owner-liveness predicate accepts are candidates: two dead
 * rows matching the same scope is not ambiguity anyone can act on.
 */
export declare function resolveSessionForConversationDetailed<T extends InspectableSession & Parameters<SessionOwnerLiveness>[0]>(sessions: readonly T[], conversation: {
    comm: string;
    account_label: string;
}, sessionOwnerIsLive: SessionOwnerLiveness): DetailedSessionResolution<T>;
export interface InspectInboundTargetDeps {
    storage: Storage;
    bridges: readonly AgentBridge[];
    daemonOwner: DaemonSelfIdentity;
    sessionOwnerIsLive: SessionOwnerLiveness;
}
/**
 * Read-only. Performs no writes, no CAS, and no lease mutation.
 */
export declare function handleInspectInboundTarget(params: Record<string, unknown>, deps: InspectInboundTargetDeps): Promise<unknown>;
//# sourceMappingURL=inspect-inbound-target.d.ts.map
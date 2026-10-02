import type { AgentId, CommId, Session, Storage } from "agents-comm-bus-core";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
type ScopeConversation = {
    comm: CommId;
    account_label: string;
};
/**
 * Storage-first inbound wake target: live owner, then herdr identity, then legacy.
 * Scope matches the conversation label the same way as the pre-AGE-110 hydrate path.
 */
export declare function selectActiveSessionForInboundWake(storage: Storage, project: string, agent: AgentId, conversation: ScopeConversation | undefined, sessionOwnerIsLive: SessionOwnerLiveness): Promise<Session | null>;
/** End stale unleased siblings when a herdr session is registered for the same scope. */
export declare function supersedeStaleSessionsOnHerdrRegister(storage: Storage, herdrSession: Session, sessionOwnerIsLive: SessionOwnerLiveness, now?: number): Promise<void>;
export {};
//# sourceMappingURL=wake-target-selection.d.ts.map
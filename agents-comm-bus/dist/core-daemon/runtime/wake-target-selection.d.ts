import type { AgentId, CommId, Session, Storage } from "agents-comm-bus-core";
import type { SessionOwnerRecord } from "./session-owner-liveness.js";
type ScopeConversation = {
    comm: CommId;
    account_label: string;
};
export type PreferredWakeTier = (session: Session) => boolean;
/** Codex/Pi inbound selection: prefer sessions holding a connection lease. */
export declare function sessionLeaseHeld(session: SessionOwnerRecord): boolean;
/**
 * Storage-first inbound wake target: preferred tier, then herdr identity, then legacy.
 * Claude passes owner liveness; Codex/Pi pass {@link sessionLeaseHeld}.
 */
export declare function selectActiveSessionForInboundWake(storage: Storage, project: string, agent: AgentId, conversation: ScopeConversation | undefined, isPreferredTier: PreferredWakeTier): Promise<Session | null>;
/** End stale unleased siblings when a herdr session is registered for the same scope. */
export declare function supersedeStaleSessionsOnHerdrRegister(storage: Storage, herdrSession: Session, sessionOwnerIsLive: PreferredWakeTier, now?: number): Promise<void>;
export {};
//# sourceMappingURL=wake-target-selection.d.ts.map
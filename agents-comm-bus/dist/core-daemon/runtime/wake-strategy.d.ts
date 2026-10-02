import type { AgentId, AuditStore, ConversationId, Session, SessionId, Storage } from "agents-comm-bus-core";
import type { ClaudeWakeResponsePayload } from "../bridges/claude/wake.js";
import { HerdrClient, type HerdrIdentity, type HerdrWakeStrict } from "./herdr.js";
import { type SessionOwnerLiveness } from "./session-owner-liveness.js";
export type WakeMode = "auto" | "native";
export type EffectiveWakeStrategy = "herdr" | "native";
export declare function resolveWakeMode(storage: Storage, project: string, agent: Session["agent"]): Promise<WakeMode>;
export declare function effectiveWakeStrategy(session: Session, mode: WakeMode): EffectiveWakeStrategy;
export interface HerdrWakeDeps {
    storage: Storage;
    audit?: AuditStore;
    clientFactory?: (identity: HerdrIdentity) => HerdrClient;
    now?: () => number;
    conversationId?: ConversationId;
}
export declare function herdrWake(session: Session, seedText: string, deps: HerdrWakeDeps): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
    strict: boolean;
}>;
export declare function herdrRespond(session: Session, payload: ClaudeWakeResponsePayload, deps: HerdrWakeDeps): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
    strict: boolean;
}>;
export declare function wakeSeedFromMessage(input: {
    comm?: string;
    sender?: string;
    body?: string;
}): string;
export declare function parseWakeStrict(raw: unknown): HerdrWakeStrict | null;
export declare function wakeStrategyForSession(storage: Storage, session: Session): Promise<EffectiveWakeStrategy>;
export declare function validateHerdrRegisterParams(params: Record<string, unknown>, expectedAgent: AgentId): {
    ok: true;
} | {
    ok: false;
    reason: "invalid herdr_identity";
};
export declare function applyHerdrWakeTargetFromRegisterParams(storage: Storage, session: SessionId, params: Record<string, unknown>, expectedAgent: AgentId, sessionOwnerIsLive?: SessionOwnerLiveness): Promise<void>;
//# sourceMappingURL=wake-strategy.d.ts.map
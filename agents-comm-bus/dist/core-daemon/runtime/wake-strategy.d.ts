import type { AuditStore, Session, Storage } from "agents-comm-bus-core";
import type { ClaudeWakeResponsePayload } from "../bridges/claude/wake.js";
import { HerdrClient, type HerdrIdentity, type HerdrWakeStrict } from "./herdr.js";
export type WakeMode = "auto" | "native";
export type EffectiveWakeStrategy = "herdr" | "native";
export declare function resolveWakeMode(storage: Storage, project: string, agent: Session["agent"]): Promise<WakeMode>;
export declare function effectiveWakeStrategy(session: Session, mode: WakeMode): EffectiveWakeStrategy;
export interface HerdrWakeDeps {
    storage: Storage;
    audit?: AuditStore;
    clientFactory?: (identity: HerdrIdentity) => HerdrClient;
    now?: () => number;
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
//# sourceMappingURL=wake-strategy.d.ts.map
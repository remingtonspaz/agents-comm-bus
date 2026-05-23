import type { ConversationId } from "../../packages/core-contracts/dist/types.js";
import type { LegacyLastChat, LegacyStateFile } from "./legacy-readers.js";
import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "./legacy-readers.js";
export interface ImportedLastChatConversation {
    conversation_id: ConversationId;
    agent: string;
    project: string;
    comm: "telegram";
    account_label: string;
    chat_native_id: string;
    thread_native_id: string | null;
    last_inbound_at: number | null;
    last_inbound_sender_id: string | null;
    source_file: string;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export type ImportLastChatResult = {
    status: "imported";
    record: ImportedLastChatConversation;
    audit: TransitionImportAudit;
} | {
    status: "skipped";
    reason: string;
    source_file: string;
    audit: TransitionImportAudit;
};
export interface TransitionImportAudit {
    kind: "legacy_state_imported" | "legacy_state_skipped";
    source: "last-chat";
    path: string;
    reason?: string;
    detail: Record<string, unknown>;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface ImportLastChatOptions {
    project: string;
    accountLabel?: string;
}
export declare function importLastChat(file: LegacyStateFile<LegacyLastChat>, options: ImportLastChatOptions): ImportLastChatResult;
//# sourceMappingURL=import-last-chat.d.ts.map
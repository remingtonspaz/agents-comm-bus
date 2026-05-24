import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "./legacy-readers.js";
export function importLastChat(file, options) {
    const chatId = file.value.chat_id?.trim();
    if (!chatId)
        return skipped(file.path, "missing chat_id");
    const updatedAt = file.value.updated_at ? Date.parse(file.value.updated_at) : NaN;
    const conversationId = stableConversationId(options.project, file.agent, options.accountLabel ?? "legacy", chatId, file.value.message_thread_id);
    const record = {
        conversation_id: conversationId,
        agent: file.agent,
        project: options.project,
        comm: "telegram",
        account_label: options.accountLabel ?? "legacy",
        chat_native_id: chatId,
        thread_native_id: file.value.message_thread_id,
        last_inbound_at: Number.isFinite(updatedAt) ? updatedAt : null,
        last_inbound_sender_id: file.value.from_user_id,
        source_file: file.path,
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    };
    return {
        status: "imported",
        record,
        audit: {
            kind: "legacy_state_imported",
            source: "last-chat",
            path: file.path,
            detail: {
                agent: file.agent,
                chat_native_id: chatId,
                thread_native_id: file.value.message_thread_id,
                imported_as: "conversation-inventory",
            },
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        },
    };
}
function skipped(path, reason) {
    return {
        status: "skipped",
        reason,
        source_file: path,
        audit: {
            kind: "legacy_state_skipped",
            source: "last-chat",
            path,
            reason,
            detail: {},
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        },
    };
}
function stableConversationId(project, agent, accountLabel, chatId, threadId) {
    return `legacy:${project}:${agent}:telegram:${accountLabel}:${chatId}:${threadId ?? ""}`;
}
//# sourceMappingURL=import-last-chat.js.map
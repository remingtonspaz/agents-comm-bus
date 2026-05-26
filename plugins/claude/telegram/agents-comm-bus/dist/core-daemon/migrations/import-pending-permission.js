import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "./legacy-readers.js";
export function importPendingPermission(file, options) {
    const createdAt = Date.parse(file.value.timestamp);
    if (!Number.isFinite(createdAt))
        return skipped(file.path, "invalid timestamp");
    const ttlSeconds = options.ttlSeconds ?? 300;
    const now = options.now ?? Date.now();
    if (now - createdAt >= ttlSeconds * 1000)
        return skipped(file.path, "pending permission is expired");
    const kind = file.value.prompt_type === "question" ? "choice" : "approval";
    const record = {
        query_id: `legacy:${file.agent}:${createdAt}:${file.value.tool_name ?? "permission"}`,
        agent: file.agent,
        session: options.sessionId,
        kind,
        prompt_text: promptText(file.value),
        created_at: createdAt,
        ttl_seconds: ttlSeconds,
        chat_native_id: file.value.chat_id,
        thread_native_id: file.value.message_thread_id,
        source_file: file.path,
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    };
    return {
        status: "imported",
        record,
        audit: {
            kind: "legacy_state_imported",
            source: "pending-permission",
            path: file.path,
            detail: {
                agent: file.agent,
                prompt_type: file.value.prompt_type,
                imported_as: "query",
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
            source: "pending-permission",
            path,
            reason,
            detail: {},
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        },
    };
}
function promptText(value) {
    const toolName = value.tool_name ?? "PermissionRequest";
    if (value.prompt_type === "question")
        return `${toolName} question`;
    if (value.prompt_type === "plan")
        return `${toolName} plan approval`;
    return `${toolName} approval`;
}
//# sourceMappingURL=import-pending-permission.js.map
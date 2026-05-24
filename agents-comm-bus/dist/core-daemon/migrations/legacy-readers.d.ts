export declare const TRANSITION_ONLY_MARKER = "transition-only";
export declare const TRANSITION_CLEANUP_RELEASE = "v4.1-cleanup";
export type LegacyAgent = "claude" | "codex";
export type LegacyStateKind = "last-chat" | "pending-permission" | "queue";
export interface LegacyReaderOptions {
    projectRoot: string;
    homeDir?: string;
    now?: number;
    pendingTtlMs?: number;
}
export interface LegacyCredentialCandidate {
    kind: "credential";
    agent: LegacyAgent;
    path: string;
    scope: "project" | "home";
    priority: number;
    hasBotToken: boolean;
    userIds: string[];
    credentialRef: string;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface LegacySessionRoot {
    kind: "session-root";
    agent: LegacyAgent;
    path: string;
    projectHint: string;
    expectedForProject: boolean;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface LegacyLastChat {
    chat_id: string;
    message_thread_id: string | null;
    from_user_id: string | null;
    updated_at: string | null;
}
export interface LegacyPendingPermission {
    timestamp: string;
    tool_name: string | null;
    tool_input: Record<string, unknown> | null;
    prompt_type: "permission" | "question" | "plan" | string;
    chat_id: string | null;
    message_thread_id: string | null;
}
export interface LegacyQueueMessage {
    id: string;
    timestamp: number | string | null;
    text: string;
    from: string | null;
    chatId: string | null;
    imagePath?: string;
}
export interface LegacyStateFile<T> {
    kind: LegacyStateKind;
    agent: LegacyAgent;
    path: string;
    sessionRoot: string;
    value: T;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface LegacySkippedFile {
    kind: LegacyStateKind | "credential" | "session-root";
    agent?: LegacyAgent;
    path: string;
    reason: string;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface LegacyDiscoveryResult {
    projectRoot: string;
    homeDir: string;
    credentials: LegacyCredentialCandidate[];
    sessionRoots: LegacySessionRoot[];
    lastChats: LegacyStateFile<LegacyLastChat>[];
    pendingPermissions: LegacyStateFile<LegacyPendingPermission>[];
    queues: LegacyStateFile<LegacyQueueMessage[]>[];
    skipped: LegacySkippedFile[];
}
export declare function legacySessionDirForProject(projectRoot: string, agent: LegacyAgent, homeDir?: string): string;
export declare function discoverLegacyInputs(options: LegacyReaderOptions): LegacyDiscoveryResult;
//# sourceMappingURL=legacy-readers.d.ts.map
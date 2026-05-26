import type { Conversation, SessionId, Storage } from "agents-comm-bus-core";
export interface ClaudeWakeRegistration {
    session: SessionId;
    project: string;
    wakeDir: string;
    registeredAt: number;
}
export declare function hashProjectKey(projectPath: string): string;
export declare function claudeWakeDirForProject(projectPath: string, homeDir?: string): string;
export declare function writeClaudeWakeTrigger(wakeDir: string, now?: () => number): Promise<void>;
export type ClaudeWakeResponsePromptType = "permission" | "question" | "freetext";
export interface ClaudeWakeResponsePayload {
    response: string;
    prompt_type: ClaudeWakeResponsePromptType;
}
export declare function writeClaudeWakeResponse(wakeDir: string, payload: ClaudeWakeResponsePayload): Promise<void>;
export declare class ClaudeWakeRegistry {
    private readonly now;
    private readonly registrations;
    private storage;
    constructor(now?: () => number);
    /**
     * Inject the daemon's storage so wake lookups can fall back to the
     * persisted `sessions` table when the in-memory map is empty (e.g. after
     * a daemon restart, before the agent's MCP shim / hooks have re-issued
     * `claude_register_session`). The Claude wake_dir is deterministic from
     * project, so no extra schema column is needed — the session row's
     * `project` is enough to reconstruct the dir via
     * `claudeWakeDirForProject`.
     */
    setStorage(storage: Storage): void;
    register(input: {
        session: SessionId;
        project: string;
        wakeDir?: string;
    }): ClaudeWakeRegistration;
    latestForProject(project: string): ClaudeWakeRegistration | undefined;
    getForSession(session: SessionId): ClaudeWakeRegistration | undefined;
    writeResponseForSession(session: SessionId, payload: ClaudeWakeResponsePayload): Promise<boolean>;
    wakeConversation(conversation: Conversation): Promise<boolean>;
    /**
     * On a miss in `wakeConversation`, look up the most recent Claude session
     * for this project from storage and seed the in-memory map. The wake_dir
     * is deterministic from project, so reconstruction is lossless even
     * across daemon restarts.
     */
    private hydrateLatestForProject;
    /**
     * On a miss in `writeResponseForSession`, look up the specific session
     * row in storage and reconstruct its wake registration so we can write
     * the wake response after a daemon restart.
     */
    private hydrateRegistrationForSession;
}
//# sourceMappingURL=wake.d.ts.map
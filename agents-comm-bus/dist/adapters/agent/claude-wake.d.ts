import type { Conversation, SessionId } from "../../../../agents-comm-bus-core/dist/index.js";
export interface ClaudeWakeRegistration {
    session: SessionId;
    project: string;
    wakeDir: string;
    registeredAt: number;
}
export declare function hashProjectKey(projectPath: string): string;
export declare function claudeWakeDirForProject(projectPath: string, homeDir?: string): string;
export declare function writeClaudeWakeTrigger(wakeDir: string, now?: () => number): Promise<void>;
export declare class ClaudeWakeRegistry {
    private readonly now;
    private readonly registrations;
    constructor(now?: () => number);
    register(input: {
        session: SessionId;
        project: string;
        wakeDir?: string;
    }): ClaudeWakeRegistration;
    latestForProject(project: string): ClaudeWakeRegistration | undefined;
    wakeConversation(conversation: Conversation): Promise<boolean>;
}
//# sourceMappingURL=claude-wake.d.ts.map
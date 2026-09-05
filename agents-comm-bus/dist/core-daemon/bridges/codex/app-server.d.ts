export declare const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";
export interface CodexRecordedTarget {
    threadId: string;
    expectedProject: string;
}
export type CodexTargetValidationResult = {
    ok: true;
    threadId: string;
    cwd: string;
} | {
    ok: false;
    reason: "missing-recorded-target" | "listThreads-failed" | "recorded-thread-absent" | "recorded-thread-not-live" | "recorded-thread-wrong-project" | "recorded-thread-missing-cwd";
    error?: string;
    threadId?: string;
    raw?: string;
    url?: string;
};
export interface CodexAppServerClient {
    call(method: string, params: unknown, options?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    listThreads(): Promise<unknown>;
    listThreadTurns(threadId: string): Promise<unknown>;
    startTurn(threadId: string, text: string): Promise<unknown>;
    steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown>;
    validateRecordedTarget(target: CodexRecordedTarget): Promise<CodexTargetValidationResult>;
    wakeRecordedTarget(target: CodexRecordedTarget, text?: string): Promise<CodexTurnResult>;
    steerRecordedTarget(target: CodexRecordedTarget, text: string): Promise<CodexTurnResult>;
}
export type CodexTurnResult = {
    ok: true;
    threadId: string;
    method: "turn/start" | "turn/steer";
    fallbackFrom?: {
        ok: false;
        reason: string;
        error?: string;
        threadId?: string;
        raw?: string;
        url?: string;
    };
} | {
    ok: false;
    reason: string;
    error?: string;
    threadId?: string;
    raw?: string;
    url?: string;
};
export declare class WebSocketCodexAppServerClient implements CodexAppServerClient {
    private readonly url;
    constructor(url?: string);
    call(method: string, params: unknown, options?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    listThreads(): Promise<unknown>;
    listThreadTurns(threadId: string): Promise<unknown>;
    startTurn(threadId: string, text: string): Promise<unknown>;
    steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown>;
    validateRecordedTarget(target: CodexRecordedTarget): Promise<CodexTargetValidationResult>;
    wakeRecordedTarget(target: CodexRecordedTarget, text?: string): Promise<CodexTurnResult>;
    steerRecordedTarget(target: CodexRecordedTarget, text: string): Promise<CodexTurnResult>;
    private activeTurn;
}
export declare function isLiveThreadStatus(statusType: string | null): boolean;
/** Live threads on an app-server whose cwd matches the expected project path. */
export declare function liveThreadsMatchingProject(listResult: unknown, expectedProject: string): Array<{
    threadId: string;
    cwd: string;
}>;
//# sourceMappingURL=app-server.d.ts.map
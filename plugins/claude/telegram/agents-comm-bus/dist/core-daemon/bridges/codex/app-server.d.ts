export declare const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";
export interface CodexAppServerClient {
    call(method: string, params: unknown, options?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    listLoadedThreads(): Promise<unknown>;
    listThreadTurns(threadId: string): Promise<unknown>;
    startTurn(threadId: string, text: string): Promise<unknown>;
    steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown>;
    wakeMostRecentThread(text?: string): Promise<CodexTurnResult>;
    steerMostRecentThread(text: string): Promise<CodexTurnResult>;
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
    listLoadedThreads(): Promise<unknown>;
    listThreadTurns(threadId: string): Promise<unknown>;
    startTurn(threadId: string, text: string): Promise<unknown>;
    steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown>;
    wakeMostRecentThread(text?: string): Promise<CodexTurnResult>;
    steerMostRecentThread(text: string): Promise<CodexTurnResult>;
    private mostRecentThread;
    private activeTurn;
}
//# sourceMappingURL=app-server.d.ts.map
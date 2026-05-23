import type { AgentAdapter, AgentCapabilities, AgentId, ControlChannel, Message, Query, QueryChannel, QueryId, ResolvedDecision, SessionId } from "../../../../../packages/core-contracts/dist/index.js";
import { type CodexAppServerClient, type CodexTurnResult } from "./app-server.js";
export interface CodexHookPayload {
    hook_event_name?: string;
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
}
export interface CodexQueryMetadata {
    hook_event_name?: string;
    tool_name: string;
    prompt_type: "permission";
    codex_session_id?: string;
}
export interface CodexQueryMapping {
    query: Query;
    metadata: CodexQueryMetadata;
}
export interface CodexAgentAdapterOptions {
    now?: () => number;
    defaultTtlSeconds?: number;
    defaultAppServerUrl?: string;
    wakePlaceholder?: string;
    queryIdFactory?: (payload: CodexHookPayload) => QueryId;
    appServerClientFactory?: (url: string) => CodexAppServerClient;
}
export interface CodexHookDecision {
    hookSpecificOutput: {
        hookEventName: "PermissionRequest";
        decision: {
            behavior: "allow" | "deny";
            message?: string;
        };
    };
}
export declare class CodexAgentAdapter implements AgentAdapter {
    private readonly options;
    readonly id: AgentId;
    readonly capabilities: AgentCapabilities;
    private readonly sessions;
    private readonly now;
    private readonly defaultTtlSeconds;
    private readonly defaultAppServerUrl;
    private readonly wakePlaceholder;
    private readonly queryIdFactory;
    private readonly appServerClientFactory;
    constructor(options?: CodexAgentAdapterOptions);
    connect(session: SessionId, controlChannel: ControlChannel): Promise<void>;
    disconnect(session: SessionId): Promise<void>;
    setAppServerUrl(session: SessionId, url: string | undefined): void;
    deliverInbound(session: SessionId, message: Message): Promise<void>;
    openQuery(session: SessionId, query: Query, queryChannel: QueryChannel): Promise<void>;
    wake(session: SessionId): Promise<void>;
    wakeOrSteer(session: SessionId, payload: unknown): Promise<CodexTurnResult>;
    steer(session: SessionId, payload: unknown): Promise<void>;
    interrupt(_session: SessionId): Promise<void>;
    drainQueuedInbound(session: SessionId): Message[];
    mapHookPayloadToQuery(session: SessionId, payload: CodexHookPayload): CodexQueryMapping;
    private supportsQueryKind;
    private clientFor;
    private requireSession;
}
export declare function mapCodexHookPayloadToQuery(session: SessionId, payload: CodexHookPayload, options?: {
    agent?: AgentId;
    now?: () => number;
    ttlSeconds?: number;
    queryId?: QueryId;
}): CodexQueryMapping;
export declare function codexDecisionFromResolution(resolution: ResolvedDecision | null): CodexHookDecision;
export declare function codexHookDecision(behavior: "allow" | "deny", message?: string): CodexHookDecision;
//# sourceMappingURL=adapter.d.ts.map
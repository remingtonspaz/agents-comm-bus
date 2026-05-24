import type { AgentAdapter, AgentCapabilities, AgentId, ControlChannel, Message, Query, QueryChannel, QueryId, ResolvedDecision, SessionId } from "../../../packages/core-contracts/dist/index.js";
export type ClaudePromptType = "permission" | "question" | "plan_approval" | "plan_entry";
export interface ClaudeHookPayload {
    hook_event_name?: string;
    session_id?: string;
    tool_name?: string;
    tool_input?: unknown;
    prompt?: string;
}
export interface ClaudeQueryMetadata {
    hook_event_name?: string;
    tool_name: string;
    prompt_type: ClaudePromptType;
    claude_session_id?: string;
    question_index?: number;
}
export interface ClaudeQueryMapping {
    query: Query;
    metadata: ClaudeQueryMetadata;
}
export interface ClaudeAgentAdapterOptions {
    now?: () => number;
    defaultTtlSeconds?: number;
    queryIdFactory?: (payload: ClaudeHookPayload) => QueryId;
    wakeSession?: (session: SessionId) => Promise<void>;
}
export interface ClaudeHookDecision {
    decision: {
        behavior: "allow" | "deny" | "ask";
    };
}
export declare class ClaudeAgentAdapter implements AgentAdapter {
    private readonly options;
    readonly id: AgentId;
    readonly capabilities: AgentCapabilities;
    private readonly sessions;
    private readonly now;
    private readonly defaultTtlSeconds;
    private readonly queryIdFactory;
    constructor(options?: ClaudeAgentAdapterOptions);
    connect(session: SessionId, controlChannel: ControlChannel): Promise<void>;
    disconnect(session: SessionId): Promise<void>;
    deliverInbound(session: SessionId, message: Message): Promise<void>;
    openQuery(session: SessionId, query: Query, queryChannel: QueryChannel): Promise<void>;
    wake(session: SessionId): Promise<void>;
    steer(_session: SessionId, _payload: unknown): Promise<void>;
    interrupt(_session: SessionId): Promise<void>;
    drainQueuedInbound(session: SessionId): Message[];
    mapHookPayloadToQuery(session: SessionId, payload: ClaudeHookPayload): ClaudeQueryMapping;
    private supportsQueryKind;
    private requireSession;
}
export declare function mapClaudeHookPayloadToQuery(session: SessionId, payload: ClaudeHookPayload, options?: {
    agent?: AgentId;
    now?: () => number;
    ttlSeconds?: number;
    queryId?: QueryId;
}): ClaudeQueryMapping;
export declare function claudeDecisionFromResolution(query: Query, resolution: ResolvedDecision): ClaudeHookDecision;
//# sourceMappingURL=adapter.d.ts.map
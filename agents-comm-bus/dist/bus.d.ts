import type { AuditStore, BlobStore, ChatRef, CommAdapter, CommId, Conversation, ConversationId, Message, MessageId, OutboundPayload, Query, QueryId, QueryRecord, ResolvedDecision, SessionId, Storage, TranscriptStore } from "../../agents-comm-bus-core/dist/index.js";
export interface MessageBusOptions {
    project: string;
    storage: Storage;
    transcripts: TranscriptStore;
    audit: AuditStore;
    blobs?: BlobStore;
    comms?: CommAdapter[];
    now?: () => number;
}
export interface DispatchSink {
    enqueueInbound(message: Message, conversation: Conversation): Promise<void>;
}
export interface ResolveSink {
    /**
     * Called after `bus.resolveQuery` successfully marks a query resolved.
     * Hosts use this to push a wake/response to the agent (e.g. write
     * `permission-response.json` + `trigger-enter` for the Claude watcher).
     */
    onResolved(query: QueryRecord, decision: ResolvedDecision): Promise<void>;
}
export type CallbackResolveOutcome = {
    kind: "resolved";
    decision: ResolvedDecision;
    query: QueryRecord;
} | {
    kind: "awaiting_freetext";
    query: QueryRecord;
} | {
    kind: "already_resolved";
} | {
    kind: "expired";
} | {
    kind: "unknown_query";
} | {
    kind: "invalid_value";
    value: string;
};
export interface SendRequest {
    session: SessionId;
    comm: CommId;
    payload: OutboundPayload;
    target?: ChatRef;
    idempotencyKey?: string;
}
export declare class MessageBus {
    private readonly options;
    /**
     * Adapter map keyed by `${commId}:${accountId}` so multiple bots can share
     * `comm.id` (e.g. one Telegram adapter per agent, each bound to a different
     * `bot_user_id`). `bus.send` resolves `target.account` to a bot_user_id via
     * `registrationFor` before lookup, so callers can pass either the
     * `account_label` (e.g. `"main"`) or the bot id directly.
     */
    private readonly comms;
    private readonly seen;
    private readonly now;
    private dispatchSink;
    private readonly resolveSinks;
    constructor(options: MessageBusOptions);
    registerComm(comm: CommAdapter): void;
    setDispatchSink(sink: DispatchSink): void;
    setResolveSink(sink: ResolveSink): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    receiveInbound(message: Message): Promise<Conversation>;
    send(request: SendRequest): Promise<MessageId>;
    openQuery(query: Query): Promise<void>;
    private tryResolveOpenQuery;
    resolveQuery(queryId: QueryId, decision: ResolvedDecision): Promise<boolean>;
    resolveQueryFromCallback(input: {
        queryId: QueryId;
        value: string;
        fromId: string;
        chat: ChatRef;
    }): Promise<CallbackResolveOutcome>;
    listConversations(filter?: {
        comm?: CommId;
        limit?: number;
    }): Promise<Conversation[]>;
    private registrationFor;
    private upsertConversation;
    private targetFromSession;
    private findConversationForTarget;
    private notifyResolveSinks;
}
export declare function conversationIdForPk(pk: {
    project: string;
    comm: CommId;
    account_label: string;
    chat_native_id: string;
    thread_native_id: string | null;
}): ConversationId;
export declare function conversationIdForChat(chat: ChatRef): ConversationId;
export declare function chatRefFromConversation(conversation: Conversation): ChatRef;
//# sourceMappingURL=bus.d.ts.map
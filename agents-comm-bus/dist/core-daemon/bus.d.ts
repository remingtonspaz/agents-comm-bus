import type { AccountId, AuditStore, BlobStore, ChatRef, CommAdapter, CommId, Conversation, ConversationId, Message, MessageId, OutboundPayload, Query, QueryId, QueryRecord, ResolvedDecision, SessionId, Storage, TranscriptStore } from "agents-comm-bus-core";
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
     * `bot_user_id`). `bus.send` resolves `target.account` by concrete bot id
     * only; account labels are display metadata and are rejected as send targets.
     */
    private readonly comms;
    private readonly seen;
    private readonly now;
    private dispatchSink;
    private readonly resolveSinks;
    constructor(options: MessageBusOptions);
    registerComm(comm: CommAdapter): void;
    /**
     * Detach a comm adapter from the bus map. Does NOT call `comm.stop()` —
     * callers (typically the daemon's reload path) are responsible for the
     * lifecycle so they can sequence stop + detach in the order they want.
     * Returns the removed adapter so the caller can stop it, or null if no
     * adapter was registered for that `(commId, accountId)`.
     */
    unregisterComm(commId: CommId, accountId: AccountId): CommAdapter | null;
    /** List the `(commId, accountId)` pairs currently attached to the bus. */
    listComms(): Array<{
        commId: CommId;
        accountId: AccountId;
    }>;
    /**
     * Look up a currently-attached adapter by `(commId, accountId)`. Used by
     * the daemon's reload path to refresh per-adapter state (e.g. allowlist
     * updates) without tearing down and recreating the adapter.
     */
    getComm(commId: CommId, accountId: AccountId): CommAdapter | null;
    setDispatchSink(sink: DispatchSink): void;
    setResolveSink(sink: ResolveSink): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    receiveInbound(message: Message): Promise<Conversation>;
    send(request: SendRequest): Promise<MessageId>;
    openQuery(query: Query): Promise<void>;
    private tryResolveOpenQuery;
    /**
     * AGE-9: a bare reply matched more than one open query — never guess which
     * one was meant. Tell the user how to disambiguate (buttons are precise;
     * replying to the specific prompt message is precise). Best-effort: a
     * helper-send failure must not block inbound processing.
     */
    private sendAmbiguousReplyHelper;
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
    /**
     * Resolve a routing target to its registration by the concrete
     * `bot_user_id` ONLY (AGE-15). Account labels (e.g. `"main"`) are human
     * metadata, not durable routing keys: Claude and Codex both register
     * `account_label="main"`, so resolving a label is inherently ambiguous and
     * can surface one agent's outbound on the other's bot (`cbc4a43`, the
     * 2026-05-30 misroute). The prior cross-project label fallback was the bug;
     * it is removed. Every legitimate caller already passes a concrete bot id:
     * inbound carries it from the adapter, session-derived sends resolve it via
     * `targetFromSession`, and `origin_chat` is built by `chatRefForConversation`
     * (which returns `bot_user_id`). A label reaching here now fails loud.
     */
    private registrationFor;
    private upsertConversation;
    private targetFromSession;
    private findConversationForTarget;
    private botUserIdForConversation;
    private notifyResolveSinks;
}
export declare function conversationIdForChat(chat: ChatRef): ConversationId;
export declare function chatRefFromConversation(conversation: Conversation): ChatRef;
//# sourceMappingURL=bus.d.ts.map
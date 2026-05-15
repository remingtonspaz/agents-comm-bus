import type { AuditStore, BlobStore, ChatRef, CommAdapter, CommId, Conversation, ConversationId, Message, MessageId, OutboundPayload, Query, QueryId, ResolvedDecision, SessionId, Storage, TranscriptStore } from "../../agents-comm-bus-core/dist/index.js";
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
export interface SendRequest {
    session: SessionId;
    comm: CommId;
    payload: OutboundPayload;
    target?: ChatRef;
    idempotencyKey?: string;
}
export declare class MessageBus {
    private readonly options;
    private readonly comms;
    private readonly seen;
    private readonly now;
    private dispatchSink;
    constructor(options: MessageBusOptions);
    registerComm(comm: CommAdapter): void;
    setDispatchSink(sink: DispatchSink): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    receiveInbound(message: Message): Promise<Conversation>;
    send(request: SendRequest): Promise<MessageId>;
    openQuery(query: Query): Promise<void>;
    resolveQuery(queryId: QueryId, decision: ResolvedDecision): Promise<boolean>;
    listConversations(filter?: {
        comm?: CommId;
        limit?: number;
    }): Promise<Conversation[]>;
    private registrationFor;
    private upsertConversation;
    private targetFromSession;
    private findConversationForTarget;
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
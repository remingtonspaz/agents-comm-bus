import type { ResolvedDecision } from "agents-comm-bus-core";
import type { AccountRegistration, AllowlistGlobalEntry, AllowlistPerBotEntry, Conversation, QueryRecord, Session } from "agents-comm-bus-core/records";
import type { AccountRelabelInput, AccountRelabelResult, AccountTokenUpdateInput, AccountTokenUpdateResult, PendingInboundDeliveryKey, PendingInboundDeliveryRow, SessionEndObservation, SessionLeaseOwner, Storage } from "agents-comm-bus-core/storage/storage";
import type { AgentId, CommId, ConversationId, MessageId, QueryId, SessionId } from "agents-comm-bus-core";
import { type SqliteLike } from "./schema/runner.js";
export declare class SqliteStorage implements Storage {
    private readonly db;
    constructor(db: SqliteLike & {
        close(): void;
    });
    static open(path: string): Promise<SqliteStorage>;
    putAccountRegistration(rec: AccountRegistration): Promise<void>;
    getAccountByBot(comm: CommId, bot_user_id: string): Promise<AccountRegistration | null>;
    listAccountRegistrations(filter?: {
        project?: string;
        comm?: CommId;
        agent?: AgentId;
    }): Promise<AccountRegistration[]>;
    deleteAccountRegistration(project: string, comm: CommId, agent: AgentId, account_label: string): Promise<void>;
    updateAccountRegistrationToken(input: AccountTokenUpdateInput): Promise<AccountTokenUpdateResult>;
    updateAccountRegistrationLabel(input: AccountRelabelInput): Promise<AccountRelabelResult>;
    upsertConversation(rec: Conversation): Promise<ConversationId>;
    /**
     * Resolve an existing conversation's stable conversation_id by its immutable
     * (registration_id, chat, thread) key — the conversations primary key as of
     * AGE-22. Returns null when no conversation exists yet (or, defensively, when
     * the record has no registration_id, which should not happen now that the
     * column is NOT NULL).
     */
    private findExistingConversationId;
    private readonly conversationSelect;
    getConversation(id: ConversationId): Promise<Conversation | null>;
    findConversation(pk: {
        project: string;
        agent: AgentId;
        comm: CommId;
        bot_user_id?: string | null;
        registration_id?: string | null;
        chat_native_id: string;
        thread_native_id: string | null;
    }): Promise<Conversation | null>;
    listConversations(filter?: {
        project?: string;
        comm?: CommId;
        agent?: AgentId;
        limit?: number;
    }): Promise<Conversation[]>;
    touchConversationInbound(id: ConversationId, at: number, message_id: MessageId): Promise<void>;
    touchConversationOutbound(id: ConversationId, at: number, message_id: MessageId): Promise<void>;
    insertQuery(rec: QueryRecord): Promise<void>;
    resolveQuery(query_id: QueryId, resolution: ResolvedDecision, resolved_at: number): Promise<boolean>;
    getOpenQueryForSession(session: SessionId): Promise<QueryRecord | null>;
    getOpenQueryByConversation(conversation_id: ConversationId): Promise<QueryRecord | null>;
    getQuery(query_id: QueryId): Promise<QueryRecord | null>;
    getOpenQueryById(query_id: QueryId): Promise<QueryRecord | null>;
    listOpenQueriesForSession(session: SessionId): Promise<QueryRecord[]>;
    listOpenQueriesByConversation(conversation_id: ConversationId): Promise<QueryRecord[]>;
    setQuerySourceMessage(query_id: QueryId, source_message_id: MessageId): Promise<boolean>;
    updateQueryKind(query_id: QueryId, kind: "approval" | "choice" | "freetext"): Promise<boolean>;
    supersedeOpenQueriesForSession(session_id: SessionId, now: number): Promise<number>;
    cancelOpenQuery(query_id: QueryId, now: number): Promise<boolean>;
    upsertSession(rec: Session): Promise<void>;
    acquireSessionLease(session: SessionId, connection_id: string, at: number, owner?: SessionLeaseOwner): Promise<boolean>;
    releaseSessionLease(session: SessionId, connection_id: string, at: number): Promise<void>;
    releaseSessionConnectionLeasePreservingOwner(session: SessionId, connection_id: string, at: number): Promise<void>;
    endSessionIfUnchanged(session: SessionId, observed: SessionEndObservation, at: number): Promise<boolean>;
    getSession(session: SessionId): Promise<Session | null>;
    listSessions(filter?: {
        project?: string;
        agent?: AgentId;
        status?: Session["status"];
        account_label_scope?: string | null;
    }): Promise<Session[]>;
    setSessionMostRecentInbound(session: SessionId, conversation_id: ConversationId): Promise<void>;
    addAllowlistGlobal(rec: AllowlistGlobalEntry): Promise<void>;
    removeAllowlistGlobal(comm: CommId, sender_id: string): Promise<void>;
    listAllowlistGlobal(filter?: {
        comm?: CommId;
    }): Promise<AllowlistGlobalEntry[]>;
    addAllowlistPerBot(rec: AllowlistPerBotEntry): Promise<void>;
    removeAllowlistPerBot(comm: CommId, bot_user_id: string, sender_id: string): Promise<void>;
    listAllowlistPerBot(filter?: {
        comm?: CommId;
        bot_user_id?: string;
    }): Promise<AllowlistPerBotEntry[]>;
    recordPendingInboundDelivery(row: PendingInboundDeliveryRow): Promise<void>;
    listPendingInboundDeliveries(filter: {
        project: string;
        agent: AgentId;
    }): Promise<PendingInboundDeliveryRow[]>;
    acknowledgePendingInboundDeliveries(keys: PendingInboundDeliveryKey[]): Promise<void>;
    close(): Promise<void>;
    private allowlistGlobalFromRow;
    private allowlistPerBotFromRow;
    private accountFromRow;
    private conversationFromRow;
    private queryFromRow;
    private pendingInboundDeliveryFromRow;
    private sessionFromRow;
}
export declare function openSqliteStorage(path: string): Promise<SqliteStorage>;
//# sourceMappingURL=sqlite.d.ts.map
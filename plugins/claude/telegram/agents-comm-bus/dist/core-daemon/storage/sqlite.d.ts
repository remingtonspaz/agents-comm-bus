import type { ResolvedDecision } from "agents-comm-bus-core";
import type { AccountRegistration, AllowlistGlobalEntry, AllowlistPerBotEntry, Conversation, QueryRecord, Session } from "agents-comm-bus-core/records";
import type { AccountTokenUpdateInput, AccountTokenUpdateResult, SessionLeaseOwner, Storage } from "agents-comm-bus-core/storage/storage";
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
    upsertConversation(rec: Conversation): Promise<ConversationId>;
    /**
     * Resolve an existing conversation's stable conversation_id by the immutable
     * (registration_id, chat, thread) key, falling back to the legacy
     * (project, agent, comm, account_label, chat, thread) tuple for rows that
     * predate registration_id. Returns null when no conversation exists yet.
     */
    private findExistingConversationId;
    getConversation(id: ConversationId): Promise<Conversation | null>;
    findConversation(pk: {
        project: string;
        agent: AgentId;
        comm: CommId;
        account_label: string;
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
    updateQueryKind(query_id: QueryId, kind: "approval" | "choice" | "freetext"): Promise<boolean>;
    supersedeOpenQueriesForSession(session_id: SessionId, now: number): Promise<number>;
    upsertSession(rec: Session): Promise<void>;
    acquireSessionLease(session: SessionId, connection_id: string, at: number, owner?: SessionLeaseOwner): Promise<boolean>;
    releaseSessionLease(session: SessionId, connection_id: string, at: number): Promise<void>;
    getSession(session: SessionId): Promise<Session | null>;
    listSessions(filter?: {
        project?: string;
        agent?: AgentId;
        status?: Session["status"];
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
    close(): Promise<void>;
    private allowlistGlobalFromRow;
    private allowlistPerBotFromRow;
    private accountFromRow;
    private conversationFromRow;
    private queryFromRow;
    private sessionFromRow;
}
export declare function openSqliteStorage(path: string): Promise<SqliteStorage>;
//# sourceMappingURL=sqlite.d.ts.map
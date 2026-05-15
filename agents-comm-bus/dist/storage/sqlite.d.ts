import type { ResolvedDecision } from "../../../agents-comm-bus-core/dist/queries.js";
import type { AccountRegistration, Conversation, QueryRecord, Session } from "../../../agents-comm-bus-core/dist/records/index.js";
import type { Storage } from "../../../agents-comm-bus-core/dist/storage/storage.js";
import type { AgentId, CommId, ConversationId, MessageId, QueryId, SessionId } from "../../../agents-comm-bus-core/dist/types.js";
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
    upsertConversation(rec: Conversation): Promise<ConversationId>;
    getConversation(id: ConversationId): Promise<Conversation | null>;
    findConversation(pk: {
        project: string;
        comm: CommId;
        account_label: string;
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
    upsertSession(rec: Session): Promise<void>;
    acquireSessionLease(session: SessionId, connection_id: string, at: number): Promise<boolean>;
    releaseSessionLease(session: SessionId, connection_id: string, at: number): Promise<void>;
    getSession(session: SessionId): Promise<Session | null>;
    setSessionMostRecentInbound(session: SessionId, conversation_id: ConversationId): Promise<void>;
    close(): Promise<void>;
    private accountFromRow;
    private conversationFromRow;
    private queryFromRow;
    private sessionFromRow;
}
export declare function openSqliteStorage(path: string): Promise<SqliteStorage>;
//# sourceMappingURL=sqlite.d.ts.map
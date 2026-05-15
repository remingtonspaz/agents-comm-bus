// Storage contract — hides SQLite from callers.
// v4 non-negotiable #7: SQLite+JSON1 for structured state. No SQL leakage in
// this interface so an alternative engine (Postgres, in-memory) remains
// pluggable. Migration entrypoints use `PRAGMA user_version` — see ./migrations.ts.

import type {
  AgentId,
  CommId,
  ConversationId,
  MessageId,
  QueryId,
  SessionId,
} from "../types.js";
import type { ResolvedDecision } from "../queries.js";
import type {
  AccountRegistration,
  Conversation,
  QueryRecord,
  Session,
} from "../records/index.js";

export interface Storage {
  // account_registrations
  putAccountRegistration(rec: AccountRegistration): Promise<void>;
  getAccountByBot(
    comm: CommId,
    bot_user_id: string,
  ): Promise<AccountRegistration | null>;
  listAccountRegistrations(filter?: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  }): Promise<AccountRegistration[]>;
  deleteAccountRegistration(
    project: string,
    comm: CommId,
    agent: AgentId,
    account_label: string,
  ): Promise<void>;

  // conversations
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
  touchConversationInbound(
    id: ConversationId,
    at: number,
    message_id: MessageId,
  ): Promise<void>;
  touchConversationOutbound(
    id: ConversationId,
    at: number,
    message_id: MessageId,
  ): Promise<void>;

  // queries
  insertQuery(rec: QueryRecord): Promise<void>;
  /** Returns false if already resolved (resolved-once invariant). */
  resolveQuery(
    query_id: QueryId,
    resolution: ResolvedDecision,
    resolved_at: number,
  ): Promise<boolean>;
  getOpenQueryForSession(session: SessionId): Promise<QueryRecord | null>;
  getOpenQueryByConversation(
    conversation_id: ConversationId,
  ): Promise<QueryRecord | null>;
  getQuery(query_id: QueryId): Promise<QueryRecord | null>;

  // sessions
  upsertSession(rec: Session): Promise<void>;
  /** Returns false if a lease is already held by another connection. */
  acquireSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
  ): Promise<boolean>;
  releaseSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
  ): Promise<void>;
  setSessionMostRecentInbound(
    session: SessionId,
    conversation_id: ConversationId,
  ): Promise<void>;
  getSession(session: SessionId): Promise<Session | null>;

  // lifecycle
  close(): Promise<void>;
}

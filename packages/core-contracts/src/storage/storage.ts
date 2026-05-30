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
  AllowlistGlobalEntry,
  AllowlistPerBotEntry,
  Conversation,
  QueryRecord,
  Session,
} from "../records/index.js";

export interface SessionLeaseOwner {
  process_pid: number | null;
  process_label?: string | null;
}

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
    agent: AgentId;
    comm: CommId;
    account_label: string;
    bot_user_id?: string | null;
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
  getOpenQueryById(query_id: QueryId): Promise<QueryRecord | null>;
  getQuery(query_id: QueryId): Promise<QueryRecord | null>;
  /**
   * Update an open query's `kind` (e.g. flip `"choice"` → `"freetext"` when
   * the user clicks an "Other" callback to provide a custom reply). Returns
   * false if the query is missing or already resolved.
   */
  updateQueryKind(
    query_id: QueryId,
    kind: "approval" | "choice" | "freetext",
  ): Promise<boolean>;
  /**
   * Mark every open query for `session_id` as resolved with
   * `resolution_json = {"kind":"superseded"}`. Used when a new query opens
   * for a session that has stale unresolved queries the local UI already
   * answered. Returns the number of rows affected.
   */
  supersedeOpenQueriesForSession(
    session_id: SessionId,
    now: number,
  ): Promise<number>;

  // sessions
  upsertSession(rec: Session): Promise<void>;
  /** Returns false if a lease is already held by another connection. */
  acquireSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
    owner?: SessionLeaseOwner,
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
  /**
   * List sessions matching optional filters. Used for hot-restart hydration
   * of in-memory adapter state (e.g. ClaudeBridge's wake registry rebuilds
   * its project → session map from this on demand, so the first inbound
   * after a daemon restart can wake the right agent without waiting for
   * the agent to re-register).
   */
  listSessions(filter?: {
    project?: string;
    agent?: AgentId;
    status?: Session["status"];
  }): Promise<Session[]>;

  // allowlist
  /**
   * Insert (or no-op on PK collision) an allowlist row that applies across
   * every adapter of `rec.comm`. Idempotent on the (comm, sender_id) PK.
   */
  addAllowlistGlobal(rec: AllowlistGlobalEntry): Promise<void>;
  /** Remove a row. No-op when no matching row exists. */
  removeAllowlistGlobal(comm: CommId, sender_id: string): Promise<void>;
  listAllowlistGlobal(filter?: { comm?: CommId }): Promise<AllowlistGlobalEntry[]>;

  /**
   * Insert (or no-op on PK collision) an allowlist row scoped to a single
   * receiving bot. Idempotent on the (comm, bot_user_id, sender_id) PK.
   */
  addAllowlistPerBot(rec: AllowlistPerBotEntry): Promise<void>;
  /** Remove a row. No-op when no matching row exists. */
  removeAllowlistPerBot(
    comm: CommId,
    bot_user_id: string,
    sender_id: string,
  ): Promise<void>;
  listAllowlistPerBot(filter?: {
    comm?: CommId;
    bot_user_id?: string;
  }): Promise<AllowlistPerBotEntry[]>;

  // lifecycle
  close(): Promise<void>;
}

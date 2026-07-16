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

export interface PendingInboundDeliveryKey {
  conversation_id: ConversationId;
  message_id: MessageId;
  comm: CommId;
  account: string;
}

export interface PendingInboundDeliveryRow extends PendingInboundDeliveryKey {
  project: string;
  agent: AgentId;
  enqueued_at: number;
}
import type { ResolvedDecision } from "../queries.js";
import type {
  AccountRegistration,
  AllowlistGlobalEntry,
  AllowlistPerBotEntry,
  Conversation,
  QueryRecord,
  Session,
} from "../records/index.js";

/** Daemon-instance identity stamped from the serving daemon, never from IPC params. */
export interface SessionDaemonOwner {
  discovery_root: string;
  checkout_root: string | null;
  state_root: string;
  daemon_bin: string | null;
  authority_rank: string;
}

export interface SessionLeaseOwner {
  process_pid: number | null;
  process_label?: string | null;
  daemon?: SessionDaemonOwner;
}

export interface AccountTokenUpdateInput {
  comm: CommId;
  current_bot_user_id: string;
  new_bot_user_id: string;
  credentials_ref: string;
  bot_username?: string;
  updated_at: number;
}

export interface AccountTokenUpdateResult {
  previous: AccountRegistration;
  next: AccountRegistration;
  bot_changed: boolean;
  migrated_allowlist_rows: number;
  migrated_conversation_rows: number;
}

export interface AccountRelabelInput {
  comm: CommId;
  bot_user_id: string;
  account_label: string;
  updated_at: number;
}

export interface AccountRelabelResult {
  previous: AccountRegistration;
  next: AccountRegistration;
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
  updateAccountRegistrationToken(
    input: AccountTokenUpdateInput,
  ): Promise<AccountTokenUpdateResult>;
  updateAccountRegistrationLabel(
    input: AccountRelabelInput,
  ): Promise<AccountRelabelResult>;

  // conversations
  upsertConversation(rec: Conversation): Promise<ConversationId>;
  getConversation(id: ConversationId): Promise<Conversation | null>;
  // AGE-22: resolved by the stable surrogate key (registration_id) or the
  // receiving bot (bot_user_id) — never by account_label (no longer identity).
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
   * AGE-9: list ALL open queries for a session, oldest first. Multiple
   * concurrent open queries per session are allowed since migration 009;
   * the singular `getOpenQuery*` variants remain for one-open callers.
   */
  listOpenQueriesForSession(session: SessionId): Promise<QueryRecord[]>;
  /** AGE-9: list ALL open queries for a conversation, oldest first. */
  listOpenQueriesByConversation(
    conversation_id: ConversationId,
  ): Promise<QueryRecord[]>;
  /**
   * AGE-9: record the sent prompt's message id (MessageId form, e.g.
   * `telegram:123`) on a still-open query, so a comm reply that `reply_to`s
   * the prompt message resolves exactly that query (the v4
   * `matchReplyToQuery` rule, until now never activated because the column
   * was never populated). Returns false if the query is already resolved.
   */
  setQuerySourceMessage(
    query_id: QueryId,
    source_message_id: MessageId,
  ): Promise<boolean>;
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
  /**
   * AGE-37: mark a single open query as resolved with
   * `resolution_json = {"kind":"cancelled"}`. Used to roll back a
   * just-inserted query whose comm prompt failed to send — with multiple
   * concurrent open queries (migration 009) an open-but-never-seen query
   * could otherwise capture bare-digit replies meant for visible prompts.
   * Returns false if the query is missing or already resolved.
   */
  cancelOpenQuery(query_id: QueryId, now: number): Promise<boolean>;

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
  /**
   * Release the connection lease while preserving host-owner process metadata.
   * Used when a hook IPC socket closes but the host process may still be alive
   * (e.g. Claude register-session), so boot-time scope restore can re-ensure
   * comm adapters without waiting for a new register call.
   */
  releaseSessionConnectionLeasePreservingOwner(
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
    account_label_scope?: string | null;
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

  // AGE-56: durable pending inbound deliveries
  recordPendingInboundDelivery(row: PendingInboundDeliveryRow): Promise<void>;
  listPendingInboundDeliveries(filter: {
    project: string;
    agent: AgentId;
  }): Promise<PendingInboundDeliveryRow[]>;
  acknowledgePendingInboundDeliveries(
    keys: PendingInboundDeliveryKey[],
  ): Promise<void>;

  // lifecycle
  close(): Promise<void>;
}

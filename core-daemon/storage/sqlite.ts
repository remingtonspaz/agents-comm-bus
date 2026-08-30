import { createRequire } from "node:module";

import type { ResolvedDecision } from "agents-comm-bus-core";
import type {
  AccountRegistration,
  AllowlistGlobalEntry,
  AllowlistPerBotEntry,
  Conversation,
  QueryRecord,
  Session,
} from "agents-comm-bus-core/records";
import type {
  AccountActivationUpdateInput,
  AccountActivationUpdateResult,
  AccountRelabelInput,
  AccountRelabelResult,
  AccountTokenUpdateInput,
  AccountTokenUpdateResult,
  CurlInboundReceipt,
  CurlInboundReceiptAcceptInput,
  CurlInboundReceiptReserveInput,
  CurlInboundReceiptReserveResult,
  CurlInboundReceiptScope,
  PendingInboundDeliveryKey,
  PendingInboundDeliveryRow,
  SessionEndObservation,
  SessionLeaseOwner,
  Storage,
} from "agents-comm-bus-core/storage/storage";
import type {
  AgentId,
  CommId,
  ConversationId,
  MessageId,
  QueryId,
  SessionId,
} from "agents-comm-bus-core";
import { normalizeProjectPath } from "../project-path.js";
import { readProcessStartEpochMs } from "../runtime/process-start-epoch.js";
import { runStorageMigrations, type SqliteLike } from "./schema/runner.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteLike & { close(): void };
};

function encodeJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function decodeJson<T>(value: unknown): T | null {
  return typeof value === "string" ? (JSON.parse(value) as T) : null;
}

function dbThreadId(value: string | null): string {
  return value ?? "";
}

function recordThreadId(value: unknown): string | null {
  return value === "" ? null : (value as string);
}

export class SqliteStorage implements Storage {
  constructor(private readonly db: SqliteLike & { close(): void }) {}

  static async open(path: string): Promise<SqliteStorage> {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    // Wait for the write lock instead of failing instantly with SQLITE_BUSY.
    // The daemon is multi-writer: with one Telegram bot per agent, the same
    // group message arrives at both bots near-simultaneously and both record
    // inbound at once. Without busy_timeout the loser of that race gets
    // "database is locked" and the write is dropped — the symptom being a group
    // message that reaches only one agent. WAL keeps readers off writers but
    // does not serialize two concurrent writers.
    db.exec("PRAGMA busy_timeout = 5000");
    await runStorageMigrations(db);
    return new SqliteStorage(db);
  }

  async putAccountRegistration(rec: AccountRegistration): Promise<void> {
    const project = normalizeProjectPath(rec.project);
    this.db
      .prepare(`
        INSERT INTO account_registrations (
          schema_version, registration_id, project, comm, agent, account_label,
          bot_user_id, credentials_ref, activation, bot_username, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, comm, agent, account_label) DO UPDATE SET
          bot_user_id = excluded.bot_user_id,
          credentials_ref = excluded.credentials_ref,
          bot_username = excluded.bot_username,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json
      `)
      .run(
        rec.schema_version,
        rec.registration_id ?? null,
        project,
        rec.comm,
        rec.agent,
        rec.account_label,
        rec.bot_user_id,
        rec.credentials_ref,
        rec.activation ?? "lazy",
        rec.bot_username ?? null,
        rec.created_at,
        rec.updated_at,
        encodeJson(rec.metadata),
      );
  }

  async getAccountByBot(
    comm: CommId,
    bot_user_id: string,
  ): Promise<AccountRegistration | null> {
    const row = this.db
      .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
      .get(comm, bot_user_id);
    return row ? this.accountFromRow(row) : null;
  }

  async getAccountByRegistrationId(
    registration_id: string,
  ): Promise<AccountRegistration | null> {
    const row = this.db
      .prepare("SELECT * FROM account_registrations WHERE registration_id = ?")
      .get(registration_id);
    return row ? this.accountFromRow(row) : null;
  }

  async listAccountRegistrations(filter: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  } = {}): Promise<AccountRegistration[]> {
    const normalizedFilter = {
      ...filter,
      project: filter.project === undefined ? undefined : normalizeProjectPath(filter.project),
    };
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const key of ["project", "comm", "agent"] as const) {
      if (normalizedFilter[key] !== undefined) {
        clauses.push(`${key} = ?`);
        params.push(normalizedFilter[key]);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM account_registrations ${where} ORDER BY created_at, account_label`)
      .all(...params) as unknown[];
    return rows.map((row) => this.accountFromRow(row));
  }

  async deleteAccountRegistration(
    project: string,
    comm: CommId,
    agent: AgentId,
    account_label: string,
  ): Promise<void> {
    this.db
      .prepare(`
        DELETE FROM account_registrations
        WHERE project = ? AND comm = ? AND agent = ? AND account_label = ?
      `)
      .run(normalizeProjectPath(project), comm, agent, account_label);
  }

  async updateAccountRegistrationToken(
    input: AccountTokenUpdateInput,
  ): Promise<AccountTokenUpdateResult> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousRow = this.db
        .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
        .get(input.comm, input.current_bot_user_id);
      if (!previousRow) {
        throw new Error(
          `no account registration found for (comm=${input.comm}, bot-id=${input.current_bot_user_id})`,
        );
      }
      const previous = this.accountFromRow(previousRow);
      const botChanged = input.current_bot_user_id !== input.new_bot_user_id;

      if (botChanged) {
        const existing = this.db
          .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
          .get(input.comm, input.new_bot_user_id);
        if (existing) {
          const row = this.accountFromRow(existing);
          throw new Error(
            `${input.comm} bot id ${input.new_bot_user_id} is already registered as ` +
              `project=${row.project}, agent=${row.agent}, account_label=${row.account_label}`,
          );
        }

        const allowlistConflict = this.db
          .prepare(`
            SELECT sender_id FROM allowlist_per_bot
            WHERE comm = ? AND bot_user_id = ?
              AND sender_id IN (
                SELECT sender_id FROM allowlist_per_bot
                WHERE comm = ? AND bot_user_id = ?
              )
            LIMIT 1
          `)
          .get(input.comm, input.current_bot_user_id, input.comm, input.new_bot_user_id);
        if (allowlistConflict) {
          const row = allowlistConflict as { sender_id?: string };
          throw new Error(
            `cannot move ${input.comm} bot id ${input.current_bot_user_id} to ` +
              `${input.new_bot_user_id}: allowlist row already exists for sender ` +
              `${row.sender_id ?? "(unknown)"}`,
          );
        }
      }

      const accountResult = this.db
        .prepare(`
          UPDATE account_registrations
          SET bot_user_id = ?,
              credentials_ref = ?,
              bot_username = ?,
              updated_at = ?
          WHERE comm = ? AND bot_user_id = ?
        `)
        .run(
          input.new_bot_user_id,
          input.credentials_ref,
          input.bot_username ?? null,
          input.updated_at,
          input.comm,
          input.current_bot_user_id,
        ) as { changes?: number };
      if (Number(accountResult.changes ?? 0) !== 1) {
        throw new Error(
          `failed to update account registration for ${input.comm}/${input.current_bot_user_id}`,
        );
      }

      let migratedAllowlistRows = 0;
      let migratedConversationRows = 0;
      if (botChanged) {
        const allowlistResult = this.db
          .prepare(`
            UPDATE allowlist_per_bot
            SET bot_user_id = ?
            WHERE comm = ? AND bot_user_id = ?
          `)
          .run(input.new_bot_user_id, input.comm, input.current_bot_user_id) as { changes?: number };
        migratedAllowlistRows = Number(allowlistResult.changes ?? 0);

        const conversationResult = this.db
          .prepare(`
            UPDATE conversations
            SET bot_user_id = ?
            WHERE comm = ? AND bot_user_id = ?
          `)
          .run(input.new_bot_user_id, input.comm, input.current_bot_user_id) as { changes?: number };
        migratedConversationRows = Number(conversationResult.changes ?? 0);
      }

      const nextRow = this.db
        .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
        .get(input.comm, input.new_bot_user_id);
      if (!nextRow) {
        throw new Error(
          `updated account registration not found for ${input.comm}/${input.new_bot_user_id}`,
        );
      }

      this.db.exec("COMMIT");
      return {
        previous,
        next: this.accountFromRow(nextRow),
        bot_changed: botChanged,
        migrated_allowlist_rows: migratedAllowlistRows,
        migrated_conversation_rows: migratedConversationRows,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async updateAccountRegistrationLabel(
    input: AccountRelabelInput,
  ): Promise<AccountRelabelResult> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousRow = this.db
        .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
        .get(input.comm, input.bot_user_id);
      if (!previousRow) {
        throw new Error(
          `no account registration found for (comm=${input.comm}, bot-id=${input.bot_user_id})`,
        );
      }
      const previous = this.accountFromRow(previousRow);

      if (previous.account_label === input.account_label) {
        this.db.exec("COMMIT");
        return { previous, next: previous };
      }

      const collision = this.db
        .prepare(`
          SELECT * FROM account_registrations
          WHERE project = ? AND comm = ? AND agent = ? AND account_label = ?
        `)
        .get(previous.project, previous.comm, previous.agent, input.account_label);
      if (collision) {
        const row = this.accountFromRow(collision);
        throw new Error(
          `account label ${input.account_label} is already registered for ` +
            `project=${row.project}, comm=${row.comm}, agent=${row.agent} ` +
            `as bot id ${row.bot_user_id}`,
        );
      }

      const result = this.db
        .prepare(`
          UPDATE account_registrations
          SET account_label = ?,
              updated_at = ?
          WHERE registration_id = ?
        `)
        .run(input.account_label, input.updated_at, previous.registration_id) as { changes?: number };
      if (Number(result.changes ?? 0) !== 1) {
        throw new Error(
          `failed to relabel account registration for ${input.comm}/${input.bot_user_id}`,
        );
      }

      const nextRow = this.db
        .prepare("SELECT * FROM account_registrations WHERE registration_id = ?")
        .get(previous.registration_id);
      if (!nextRow) {
        throw new Error(`updated account registration not found for ${previous.registration_id}`);
      }

      this.db.exec("COMMIT");
      return { previous, next: this.accountFromRow(nextRow) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async updateAccountRegistrationActivation(
    input: AccountActivationUpdateInput,
  ): Promise<AccountActivationUpdateResult> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousRow = this.db
        .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
        .get(input.comm, input.bot_user_id);
      if (!previousRow) {
        throw new Error(
          `no account registration found for (comm=${input.comm}, bot-id=${input.bot_user_id})`,
        );
      }
      const previous = this.accountFromRow(previousRow);

      if (previous.activation === input.activation) {
        this.db.exec("COMMIT");
        return { previous, next: previous };
      }

      const result = this.db
        .prepare(`
          UPDATE account_registrations
          SET activation = ?,
              updated_at = ?
          WHERE registration_id = ?
        `)
        .run(input.activation, input.updated_at, previous.registration_id) as { changes?: number };
      if (Number(result.changes ?? 0) !== 1) {
        throw new Error(
          `failed to update activation for account registration ${previous.registration_id}`,
        );
      }

      const nextRow = this.db
        .prepare("SELECT * FROM account_registrations WHERE registration_id = ?")
        .get(previous.registration_id);
      if (!nextRow) {
        throw new Error(`updated account registration not found for ${previous.registration_id}`);
      }

      this.db.exec("COMMIT");
      return { previous, next: this.accountFromRow(nextRow) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async upsertConversation(rec: Conversation): Promise<ConversationId> {
    rec = { ...rec, project: normalizeProjectPath(rec.project) };
    // AGE-20 Phase 2: resolve the existing conversation by its STABLE identity
    // (registration_id, chat, thread) and update it in place, PRESERVING its
    // conversation_id. This stops the drift: a registration field change (e.g.
    // relabel) no longer re-keys the conversation_id or duplicates the row. We
    // never overwrite conversation_id on conflict anymore.
    // AGE-20 Phase 3a: serialize the find-then-insert so a concurrent upsert for
    // the same (registration_id, chat, thread) can't race between the lookup and
    // the insert (closes the theoretical window from Phase 2).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingId = this.findExistingConversationId(rec);
      let result: ConversationId;
      if (existingId) {
        // AGE-22: conversations no longer store account_label (it is resolved on
        // read from the owning registration).
        this.db
          .prepare(`
            UPDATE conversations SET
              bot_user_id = ?,
              registration_id = ?,
              last_inbound_at = ?,
              last_outbound_at = ?,
              last_message_id = ?,
              metadata_json = ?
            WHERE conversation_id = ?
          `)
          .run(
            rec.bot_user_id,
            rec.registration_id ?? null,
            rec.last_inbound_at,
            rec.last_outbound_at,
            rec.last_message_id,
            encodeJson(rec.metadata),
            existingId,
          );
        result = existingId as ConversationId;
      } else {
        this.db
          .prepare(`
            INSERT INTO conversations (
              schema_version, project, comm, bot_user_id, registration_id,
              chat_native_id, thread_native_id, conversation_id, agent, last_inbound_at,
              last_outbound_at, last_message_id, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(registration_id, chat_native_id, thread_native_id) DO UPDATE SET
              bot_user_id = excluded.bot_user_id,
              last_inbound_at = excluded.last_inbound_at,
              last_outbound_at = excluded.last_outbound_at,
              last_message_id = excluded.last_message_id,
              metadata_json = excluded.metadata_json
          `)
          .run(
            rec.schema_version,
            rec.project,
            rec.comm,
            rec.bot_user_id,
            rec.registration_id ?? null,
            rec.chat_native_id,
            dbThreadId(rec.thread_native_id),
            rec.conversation_id,
            rec.agent,
            rec.last_inbound_at,
            rec.last_outbound_at,
            rec.last_message_id,
            rec.created_at,
            encodeJson(rec.metadata),
          );
        result = rec.conversation_id;
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Resolve an existing conversation's stable conversation_id by its immutable
   * (registration_id, chat, thread) key — the conversations primary key as of
   * AGE-22. Returns null when no conversation exists yet (or, defensively, when
   * the record has no registration_id, which should not happen now that the
   * column is NOT NULL).
   */
  private findExistingConversationId(rec: Conversation): string | null {
    if (rec.registration_id == null) return null;
    const byReg = this.db
      .prepare(`
        SELECT conversation_id FROM conversations
        WHERE registration_id = ? AND chat_native_id = ? AND thread_native_id = ?
      `)
      .get(rec.registration_id, rec.chat_native_id, dbThreadId(rec.thread_native_id)) as
      | { conversation_id?: string }
      | undefined;
    return byReg?.conversation_id ?? null;
  }

  // AGE-22: a conversation's account_label is resolved purely from its owning
  // registration (registration_id -> account_registrations). conversations no
  // longer stores account_label (the column was dropped in migration 008), so a
  // relabel is visible immediately on every read and no behavior path keys off a
  // mutable stored label. The join misses only for an orphan/retired
  // registration; the row mapper surfaces "" in that case.
  private readonly conversationSelect = `
    SELECT c.*, ar.account_label AS effective_account_label
    FROM conversations c
    LEFT JOIN account_registrations ar ON ar.registration_id = c.registration_id
  `;

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    const row = this.db
      .prepare(`${this.conversationSelect} WHERE c.conversation_id = ?`)
      .get(id);
    return row ? this.conversationFromRow(row) : null;
  }

  async findConversation(pk: {
    project: string;
    agent: AgentId;
    comm: CommId;
    bot_user_id?: string | null;
    registration_id?: string | null;
    chat_native_id: string;
    thread_native_id: string | null;
  }): Promise<Conversation | null> {
    // AGE-22: resolve by the stable surrogate key (registration_id, chat,
    // thread) first; fall back to (bot_user_id, chat, thread) for callers that
    // only know the receiving bot. There is no account_label lookup anymore —
    // the column is gone and label is never identity.
    if (pk.registration_id) {
      const byReg = this.db
        .prepare(`
          ${this.conversationSelect}
          WHERE c.registration_id = ? AND c.chat_native_id = ? AND c.thread_native_id = ?
        `)
        .get(pk.registration_id, pk.chat_native_id, dbThreadId(pk.thread_native_id));
      if (byReg) return this.conversationFromRow(byReg);
    }
    if (pk.bot_user_id) {
      const byBot = this.db
        .prepare(`
          ${this.conversationSelect}
          WHERE c.project = ? AND c.agent = ? AND c.comm = ? AND c.bot_user_id = ?
            AND c.chat_native_id = ? AND c.thread_native_id = ?
        `)
        .get(
          normalizeProjectPath(pk.project),
          pk.agent,
          pk.comm,
          pk.bot_user_id,
          pk.chat_native_id,
          dbThreadId(pk.thread_native_id),
        );
      if (byBot) return this.conversationFromRow(byBot);
    }

    return null;
  }

  async listConversations(filter: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
    limit?: number;
  } = {}): Promise<Conversation[]> {
    const normalizedFilter = {
      ...filter,
      project: filter.project === undefined ? undefined : normalizeProjectPath(filter.project),
    };
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const key of ["project", "comm", "agent"] as const) {
      if (normalizedFilter[key] !== undefined) {
        clauses.push(`c.${key} = ?`);
        params.push(normalizedFilter[key]);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit === undefined ? "" : "LIMIT ?";
    if (filter.limit !== undefined) params.push(filter.limit);
    const rows = this.db
      .prepare(`${this.conversationSelect} ${where} ORDER BY c.created_at DESC ${limit}`)
      .all(...params) as unknown[];
    return rows.map((row) => this.conversationFromRow(row));
  }

  async touchConversationInbound(
    id: ConversationId,
    at: number,
    message_id: MessageId,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE conversations
        SET last_inbound_at = ?, last_message_id = ?
        WHERE conversation_id = ?
      `)
      .run(at, message_id, id);
  }

  async touchConversationOutbound(
    id: ConversationId,
    at: number,
    message_id: MessageId,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE conversations
        SET last_outbound_at = ?, last_message_id = ?
        WHERE conversation_id = ?
      `)
      .run(at, message_id, id);
  }

  async insertQuery(rec: QueryRecord): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO queries (
          schema_version, query_id, agent, session_id, kind, prompt_text,
          created_at, ttl_seconds, origin_chat_id, source_message_id,
          resolved_at, resolution_json, options_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        rec.schema_version,
        rec.query_id,
        rec.agent,
        rec.session,
        rec.kind,
        rec.prompt_text,
        rec.created_at,
        rec.ttl_seconds,
        rec.origin_chat_id,
        rec.source_message_id,
        rec.resolved_at,
        encodeJson(rec.resolution),
        rec.options_json,
      );
  }

  async resolveQuery(
    query_id: QueryId,
    resolution: ResolvedDecision,
    resolved_at: number,
  ): Promise<boolean> {
    const result = this.db
      .prepare(`
        UPDATE queries
        SET resolved_at = ?, resolution_json = ?
        WHERE query_id = ? AND resolved_at IS NULL
      `)
      .run(resolved_at, encodeJson(resolution), query_id) as { changes?: number };
    return result.changes === 1;
  }

  async getOpenQueryForSession(session: SessionId): Promise<QueryRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM queries WHERE session_id = ? AND resolved_at IS NULL")
      .get(session);
    return row ? this.queryFromRow(row) : null;
  }

  async getOpenQueryByConversation(
    conversation_id: ConversationId,
  ): Promise<QueryRecord | null> {
    const row = this.db
      .prepare(`
        SELECT * FROM queries
        WHERE origin_chat_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get(conversation_id);
    return row ? this.queryFromRow(row) : null;
  }

  async getQuery(query_id: QueryId): Promise<QueryRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM queries WHERE query_id = ?")
      .get(query_id);
    return row ? this.queryFromRow(row) : null;
  }

  async getOpenQueryById(query_id: QueryId): Promise<QueryRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM queries WHERE query_id = ? AND resolved_at IS NULL")
      .get(query_id);
    return row ? this.queryFromRow(row) : null;
  }

  async listOpenQueriesForSession(session: SessionId): Promise<QueryRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT * FROM queries
        WHERE session_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
      `)
      .all(session);
    return rows.map((row) => this.queryFromRow(row));
  }

  async listOpenQueriesByConversation(
    conversation_id: ConversationId,
  ): Promise<QueryRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT * FROM queries
        WHERE origin_chat_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
      `)
      .all(conversation_id);
    return rows.map((row) => this.queryFromRow(row));
  }

  async setQuerySourceMessage(
    query_id: QueryId,
    source_message_id: MessageId,
  ): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE queries SET source_message_id = ? WHERE query_id = ? AND resolved_at IS NULL")
      .run(source_message_id, query_id) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  }

  async updateQueryKind(query_id: QueryId, kind: "approval" | "choice" | "freetext"): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE queries SET kind = ? WHERE query_id = ? AND resolved_at IS NULL")
      .run(kind, query_id) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  }

  async supersedeOpenQueriesForSession(
    session_id: SessionId,
    now: number,
  ): Promise<number> {
    const result = this.db
      .prepare(`
        UPDATE queries
        SET resolved_at = ?,
            resolution_json = ?
        WHERE session_id = ?
          AND resolved_at IS NULL
      `)
      .run(now, JSON.stringify({ kind: "superseded" }), session_id) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  async cancelOpenQuery(query_id: QueryId, now: number): Promise<boolean> {
    const result = this.db
      .prepare(`
        UPDATE queries
        SET resolved_at = ?,
            resolution_json = ?
        WHERE query_id = ?
          AND resolved_at IS NULL
      `)
      .run(now, JSON.stringify({ kind: "cancelled" }), query_id) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  }

  async upsertSession(rec: Session): Promise<void> {
    const project = normalizeProjectPath(rec.project);
    this.db
      .prepare(`
        INSERT INTO sessions (
          schema_version, session_id, agent, project, created_at,
          lease_holder_connection_id, lease_acquired_at, lease_released_at,
          lease_owner_process_pid, lease_owner_process_label,
          lease_owner_process_registered_at, lease_owner_process_start_time,
          lease_owner_daemon_discovery_root, lease_owner_daemon_checkout_root,
          lease_owner_daemon_state_root, lease_owner_daemon_bin,
          lease_owner_daemon_authority_rank,
          most_recent_inbound_conversation_id, account_label_scope, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent = excluded.agent,
          project = excluded.project,
          account_label_scope = excluded.account_label_scope,
          status = excluded.status
      `)
      .run(
        rec.schema_version,
        rec.session_id,
        rec.agent,
        project,
        rec.created_at,
        rec.lease_holder_connection_id,
        rec.lease_acquired_at,
        rec.lease_released_at,
        rec.lease_owner_process_pid,
        rec.lease_owner_process_label,
        rec.lease_owner_process_registered_at,
        rec.lease_owner_process_start_time ?? null,
        rec.lease_owner_daemon_discovery_root,
        rec.lease_owner_daemon_checkout_root,
        rec.lease_owner_daemon_state_root,
        rec.lease_owner_daemon_bin,
        rec.lease_owner_daemon_authority_rank,
        rec.most_recent_inbound_conversation_id,
        rec.account_label_scope ?? null,
        rec.status,
      );
  }

  async acquireSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
    owner?: SessionLeaseOwner,
  ): Promise<boolean> {
    const ownerPid = owner?.process_pid ?? null;
    let ownerStartTime = owner?.process_start_time ?? null;
    if (ownerPid != null && ownerStartTime == null) {
      ownerStartTime = readProcessStartEpochMs(ownerPid);
    }
    try {
      const result = this.db
        .prepare(`
          UPDATE sessions
          SET lease_holder_connection_id = ?,
              lease_acquired_at = ?,
              lease_released_at = NULL,
              -- AGE-82: acquiring a lease revives the row. Registration is
              -- upsert(active) + acquire, and the sweep can end the row in
              -- between; without this a live lease would sit on an ended
              -- row, invisible to every status='active' filter and outside
              -- the partial live-lease indexes.
              status = 'active',
              lease_owner_process_pid = ?,
              lease_owner_process_label = ?,
              lease_owner_process_registered_at = ?,
              lease_owner_process_start_time = ?,
              lease_owner_daemon_discovery_root = ?,
              lease_owner_daemon_checkout_root = ?,
              lease_owner_daemon_state_root = ?,
              lease_owner_daemon_bin = ?,
              lease_owner_daemon_authority_rank = ?
          WHERE session_id = ?
            AND (lease_holder_connection_id IS NULL OR lease_holder_connection_id = ?)
        `)
        .run(
          connection_id,
          at,
          ownerPid,
          owner?.process_label ?? null,
          ownerPid ? at : null,
          ownerPid ? ownerStartTime : null,
          owner?.daemon?.discovery_root ?? null,
          owner?.daemon?.checkout_root ?? null,
          owner?.daemon?.state_root ?? null,
          owner?.daemon?.daemon_bin ?? null,
          owner?.daemon?.authority_rank ?? null,
          session,
          connection_id,
        ) as { changes?: number };
      return result.changes === 1;
    } catch (error) {
      if (isConstraintError(error)) return false;
      throw error;
    }
  }

  async releaseSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE sessions
        SET lease_holder_connection_id = NULL,
            lease_released_at = ?,
            lease_owner_process_pid = NULL,
            lease_owner_process_label = NULL,
            lease_owner_process_registered_at = NULL,
            lease_owner_process_start_time = NULL,
            lease_owner_daemon_discovery_root = NULL,
            lease_owner_daemon_checkout_root = NULL,
            lease_owner_daemon_state_root = NULL,
            lease_owner_daemon_bin = NULL,
            lease_owner_daemon_authority_rank = NULL
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `)
      .run(at, session, connection_id);
  }

  async releaseSessionConnectionLeasePreservingOwner(
    session: SessionId,
    connection_id: string,
    at: number,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE sessions
        SET lease_holder_connection_id = NULL,
            lease_released_at = ?
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `)
      .run(at, session, connection_id);
  }

  async endSessionIfUnchanged(
    session: SessionId,
    observed: SessionEndObservation,
    at: number,
  ): Promise<boolean> {
    const result = this.db
      .prepare(`
        UPDATE sessions
        SET status = 'ended',
            lease_holder_connection_id = NULL,
            lease_released_at = ?
        WHERE session_id = ?
          AND status = ?
          AND (
            (lease_holder_connection_id IS NULL AND ? IS NULL)
            OR lease_holder_connection_id = ?
          )
          AND (
            (lease_owner_process_pid IS NULL AND ? IS NULL)
            OR lease_owner_process_pid = ?
          )
          AND (
            (lease_owner_process_registered_at IS NULL AND ? IS NULL)
            OR lease_owner_process_registered_at = ?
          )
          AND (
            (lease_owner_process_start_time IS NULL AND ? IS NULL)
            OR lease_owner_process_start_time = ?
          )
      `)
      .run(
        at,
        session,
        observed.status,
        observed.lease_holder_connection_id,
        observed.lease_holder_connection_id,
        observed.lease_owner_process_pid,
        observed.lease_owner_process_pid,
        observed.lease_owner_process_registered_at,
        observed.lease_owner_process_registered_at,
        observed.lease_owner_process_start_time,
        observed.lease_owner_process_start_time,
      ) as { changes?: number };
    return Number(result.changes ?? 0) > 0;
  }

  async getSession(session: SessionId): Promise<Session | null> {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(session);
    return row ? this.sessionFromRow(row) : null;
  }

  async listSessions(filter: {
    project?: string;
    agent?: AgentId;
    status?: Session["status"];
    account_label_scope?: string | null;
  } = {}): Promise<Session[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.project !== undefined) {
      where.push("project = ?");
      params.push(normalizeProjectPath(filter.project));
    }
    if (filter.agent !== undefined) {
      where.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.account_label_scope === null) {
      where.push("account_label_scope IS NULL");
    } else if (filter.account_label_scope !== undefined) {
      where.push("account_label_scope = ?");
      params.push(filter.account_label_scope);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${whereClause} ORDER BY created_at DESC`)
      .all(...params);
    return (rows as unknown[]).map((row) => this.sessionFromRow(row));
  }

  async setSessionMostRecentInbound(
    session: SessionId,
    conversation_id: ConversationId,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE sessions
        SET most_recent_inbound_conversation_id = ?
        WHERE session_id = ?
      `)
      .run(conversation_id, session);
  }

  async addAllowlistGlobal(rec: AllowlistGlobalEntry): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO allowlist_global (comm, sender_id, added_at, added_by, note)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(comm, sender_id) DO NOTHING
      `)
      .run(rec.comm, rec.sender_id, rec.added_at, rec.added_by ?? null, rec.note ?? null);
  }

  async removeAllowlistGlobal(comm: CommId, sender_id: string): Promise<void> {
    this.db
      .prepare("DELETE FROM allowlist_global WHERE comm = ? AND sender_id = ?")
      .run(comm, sender_id);
  }

  async listAllowlistGlobal(
    filter: { comm?: CommId } = {},
  ): Promise<AllowlistGlobalEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.comm !== undefined) {
      clauses.push("comm = ?");
      params.push(filter.comm);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM allowlist_global ${where} ORDER BY comm, sender_id`)
      .all(...params) as unknown[];
    return rows.map((row) => this.allowlistGlobalFromRow(row));
  }

  async addAllowlistPerBot(rec: AllowlistPerBotEntry): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO allowlist_per_bot
          (comm, bot_user_id, sender_id, added_at, added_by, note)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(comm, bot_user_id, sender_id) DO NOTHING
      `)
      .run(
        rec.comm,
        rec.bot_user_id,
        rec.sender_id,
        rec.added_at,
        rec.added_by ?? null,
        rec.note ?? null,
      );
  }

  async removeAllowlistPerBot(
    comm: CommId,
    bot_user_id: string,
    sender_id: string,
  ): Promise<void> {
    this.db
      .prepare(
        "DELETE FROM allowlist_per_bot WHERE comm = ? AND bot_user_id = ? AND sender_id = ?",
      )
      .run(comm, bot_user_id, sender_id);
  }

  async listAllowlistPerBot(
    filter: { comm?: CommId; bot_user_id?: string } = {},
  ): Promise<AllowlistPerBotEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.comm !== undefined) {
      clauses.push("comm = ?");
      params.push(filter.comm);
    }
    if (filter.bot_user_id !== undefined) {
      clauses.push("bot_user_id = ?");
      params.push(filter.bot_user_id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM allowlist_per_bot ${where} ORDER BY comm, bot_user_id, sender_id`,
      )
      .all(...params) as unknown[];
    return rows.map((row) => this.allowlistPerBotFromRow(row));
  }

  async recordPendingInboundDelivery(row: PendingInboundDeliveryRow): Promise<void> {
    const project = normalizeProjectPath(row.project);
    this.db
      .prepare(`
        INSERT INTO pending_inbound_deliveries (
          conversation_id, message_id, comm, account, project, agent, enqueued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, message_id, comm, account) DO NOTHING
      `)
      .run(
        row.conversation_id,
        row.message_id,
        row.comm,
        row.account,
        project,
        row.agent,
        row.enqueued_at,
      );
  }

  async listPendingInboundDeliveries(filter: {
    project: string;
    agent: AgentId;
  }): Promise<PendingInboundDeliveryRow[]> {
    const project = normalizeProjectPath(filter.project);
    const rows = this.db
      .prepare(`
        SELECT * FROM pending_inbound_deliveries
        WHERE project = ? AND agent = ?
        ORDER BY enqueued_at, conversation_id, message_id
      `)
      .all(project, filter.agent) as unknown[];
    return rows.map((row) => this.pendingInboundDeliveryFromRow(row));
  }

  async acknowledgePendingInboundDeliveries(
    keys: PendingInboundDeliveryKey[],
  ): Promise<void> {
    if (keys.length === 0) return;
    const stmt = this.db.prepare(`
      DELETE FROM pending_inbound_deliveries
      WHERE conversation_id = ? AND message_id = ? AND comm = ? AND account = ?
    `);
    for (const key of keys) {
      stmt.run(key.conversation_id, key.message_id, key.comm, key.account);
    }
  }

  async reserveCurlInboundReceipt(
    input: CurlInboundReceiptReserveInput,
  ): Promise<CurlInboundReceiptReserveResult> {
    const existing = await this.getCurlInboundReceipt(input);
    if (existing) {
      if (existing.state === "accepted" && existing.expires_at <= input.reserved_at) {
        this.db
          .prepare(`
            DELETE FROM curl_inbound_receipts
            WHERE registration_id = ? AND sender_id = ? AND client_key = ?
          `)
          .run(input.registration_id, input.sender_id, input.client_key);
      } else if (existing.request_hash !== input.request_hash) {
        return { kind: "conflict" };
      } else if (existing.state === "accepted") {
        return {
          kind: "replay",
          message_id: existing.message_id,
          conversation_id: existing.conversation_id,
        };
      } else {
        return {
          kind: "resume",
          message_id: existing.message_id,
          conversation_id: existing.conversation_id,
        };
      }
    }

    try {
      this.db
        .prepare(`
          INSERT INTO curl_inbound_receipts (
            registration_id, sender_id, client_key, request_hash, message_id,
            conversation_id, state, reserved_at, accepted_at, expires_at,
            transcript_recorded_at, audit_recorded_at, dispatch_recorded_at,
            query_consumed_at, planned_query_id
          ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL)
        `)
        .run(
          input.registration_id,
          input.sender_id,
          input.client_key,
          input.request_hash,
          input.message_id,
          input.reserved_at,
          input.expires_at,
        );
      return { kind: "reserved", message_id: input.message_id };
    } catch (error) {
      if (!isSqliteUniqueViolation(error)) throw error;
      return this.reserveCurlInboundReceipt(input);
    }
  }

  async acceptCurlInboundReceipt(input: CurlInboundReceiptAcceptInput): Promise<boolean> {
    const result = this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET state = 'accepted',
            conversation_id = ?,
            accepted_at = ?
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
          AND state = 'pending'
      `)
      .run(
        input.conversation_id,
        input.accepted_at,
        input.registration_id,
        input.sender_id,
        input.client_key,
      ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  async getCurlInboundReceipt(scope: CurlInboundReceiptScope): Promise<CurlInboundReceipt | null> {
    const row = this.db
      .prepare(`
        SELECT * FROM curl_inbound_receipts
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `)
      .get(scope.registration_id, scope.sender_id, scope.client_key);
    return row ? this.curlInboundReceiptFromRow(row) : null;
  }

  async deleteExpiredCurlInboundReceipts(now: number): Promise<number> {
    const result = this.db
      .prepare(
        "DELETE FROM curl_inbound_receipts WHERE state = 'accepted' AND expires_at <= ?",
      )
      .run(now) as { changes?: number };
    return result.changes ?? 0;
  }

  async markCurlReceiptConversation(
    scope: CurlInboundReceiptScope,
    conversation_id: ConversationId,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET conversation_id = COALESCE(conversation_id, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `)
      .run(conversation_id, scope.registration_id, scope.sender_id, scope.client_key);
  }

  async markCurlReceiptTranscript(scope: CurlInboundReceiptScope, at: number): Promise<void> {
    this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET transcript_recorded_at = COALESCE(transcript_recorded_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `)
      .run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }

  async markCurlReceiptAudit(scope: CurlInboundReceiptScope, at: number): Promise<void> {
    this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET audit_recorded_at = COALESCE(audit_recorded_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `)
      .run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }

  async markCurlReceiptDispatch(scope: CurlInboundReceiptScope, at: number): Promise<void> {
    this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET dispatch_recorded_at = COALESCE(dispatch_recorded_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `)
      .run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }

  async markCurlReceiptQueryConsumed(scope: CurlInboundReceiptScope, at: number): Promise<void> {
    this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET query_consumed_at = COALESCE(query_consumed_at, ?)
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
      `)
      .run(at, scope.registration_id, scope.sender_id, scope.client_key);
  }

  async markCurlReceiptPlannedQuery(
    scope: CurlInboundReceiptScope,
    query_id: QueryId,
  ): Promise<void> {
    this.db
      .prepare(`
        UPDATE curl_inbound_receipts
        SET planned_query_id = ?
        WHERE registration_id = ? AND sender_id = ? AND client_key = ?
          AND planned_query_id IS NULL
      `)
      .run(query_id, scope.registration_id, scope.sender_id, scope.client_key);
  }

  async hasPendingInboundDelivery(key: PendingInboundDeliveryKey): Promise<boolean> {
    const row = this.db
      .prepare(`
        SELECT 1 AS present FROM pending_inbound_deliveries
        WHERE conversation_id = ? AND message_id = ? AND comm = ? AND account = ?
        LIMIT 1
      `)
      .get(key.conversation_id, key.message_id, key.comm, key.account);
    return row != null;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private allowlistGlobalFromRow(row: unknown): AllowlistGlobalEntry {
    const r = row as Record<string, unknown>;
    return {
      comm: r.comm as CommId,
      sender_id: r.sender_id as string,
      added_at: r.added_at as number,
      added_by: (r.added_by as string | null) ?? undefined,
      note: (r.note as string | null) ?? undefined,
    };
  }

  private allowlistPerBotFromRow(row: unknown): AllowlistPerBotEntry {
    const r = row as Record<string, unknown>;
    return {
      comm: r.comm as CommId,
      bot_user_id: r.bot_user_id as string,
      sender_id: r.sender_id as string,
      added_at: r.added_at as number,
      added_by: (r.added_by as string | null) ?? undefined,
      note: (r.note as string | null) ?? undefined,
    };
  }

  private accountFromRow(row: unknown): AccountRegistration {
    const r = row as Record<string, unknown>;
    return {
      schema_version: r.schema_version as AccountRegistration["schema_version"],
      registration_id: r.registration_id as string,
      project: r.project as string,
      comm: r.comm as CommId,
      agent: r.agent as AgentId,
      account_label: r.account_label as string,
      bot_user_id: r.bot_user_id as string,
      credentials_ref: r.credentials_ref as string,
      activation: (r.activation as AccountRegistration["activation"]) ?? "lazy",
      bot_username: (r.bot_username as string | null) ?? undefined,
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
      metadata: decodeJson<Record<string, unknown>>(r.metadata_json) ?? undefined,
    };
  }

  private conversationFromRow(row: unknown): Conversation {
    const r = row as Record<string, unknown>;
    return {
      schema_version: r.schema_version as Conversation["schema_version"],
      project: r.project as string,
      comm: r.comm as CommId,
      // AGE-22: registration-resolved current label (see conversationSelect).
      // "" when the join misses (orphan / retired registration).
      account_label: (r.effective_account_label ?? "") as string,
      bot_user_id: (r.bot_user_id as string | null) ?? null,
      registration_id: (r.registration_id as string | null) ?? null,
      chat_native_id: r.chat_native_id as string,
      thread_native_id: recordThreadId(r.thread_native_id),
      conversation_id: r.conversation_id as ConversationId,
      agent: r.agent as AgentId,
      last_inbound_at: r.last_inbound_at as number | null,
      last_outbound_at: r.last_outbound_at as number | null,
      last_message_id: r.last_message_id as MessageId | null,
      created_at: r.created_at as number,
      metadata: decodeJson<Record<string, unknown>>(r.metadata_json) ?? undefined,
    };
  }

  private queryFromRow(row: unknown): QueryRecord {
    const r = row as Record<string, unknown>;
    return {
      schema_version: r.schema_version as QueryRecord["schema_version"],
      query_id: r.query_id as QueryId,
      agent: r.agent as AgentId,
      session: r.session_id as SessionId,
      kind: r.kind as QueryRecord["kind"],
      prompt_text: r.prompt_text as string,
      created_at: r.created_at as number,
      ttl_seconds: r.ttl_seconds as number,
      origin_chat_id: r.origin_chat_id as ConversationId | null,
      source_message_id: r.source_message_id as MessageId | null,
      resolved_at: r.resolved_at as number | null,
      resolution: decodeJson<ResolvedDecision>(r.resolution_json),
      options_json: r.options_json as string | null,
    };
  }

  private curlInboundReceiptFromRow(row: unknown): CurlInboundReceipt {
    const r = row as Record<string, unknown>;
    return {
      registration_id: r.registration_id as string,
      sender_id: r.sender_id as string,
      client_key: r.client_key as string,
      request_hash: r.request_hash as string,
      message_id: r.message_id as MessageId,
      conversation_id: (r.conversation_id as ConversationId | null) ?? null,
      state: r.state as CurlInboundReceipt["state"],
      reserved_at: r.reserved_at as number,
      accepted_at: (r.accepted_at as number | null) ?? null,
      expires_at: r.expires_at as number,
      transcript_recorded_at: (r.transcript_recorded_at as number | null) ?? null,
      audit_recorded_at: (r.audit_recorded_at as number | null) ?? null,
      dispatch_recorded_at: (r.dispatch_recorded_at as number | null) ?? null,
      query_consumed_at: (r.query_consumed_at as number | null) ?? null,
      planned_query_id: (r.planned_query_id as QueryId | null) ?? null,
    };
  }

  private pendingInboundDeliveryFromRow(row: unknown): PendingInboundDeliveryRow {
    const r = row as Record<string, unknown>;
    return {
      conversation_id: r.conversation_id as ConversationId,
      message_id: r.message_id as MessageId,
      comm: r.comm as CommId,
      account: r.account as string,
      project: r.project as string,
      agent: r.agent as AgentId,
      enqueued_at: r.enqueued_at as number,
    };
  }

  private sessionFromRow(row: unknown): Session {
    const r = row as Record<string, unknown>;
    return {
      schema_version: r.schema_version as Session["schema_version"],
      session_id: r.session_id as SessionId,
      agent: r.agent as AgentId,
      project: r.project as string,
      created_at: r.created_at as number,
      lease_holder_connection_id: r.lease_holder_connection_id as string | null,
      lease_acquired_at: r.lease_acquired_at as number | null,
      lease_released_at: r.lease_released_at as number | null,
      lease_owner_process_pid: r.lease_owner_process_pid as number | null,
      lease_owner_process_label: r.lease_owner_process_label as string | null,
      lease_owner_process_registered_at:
        r.lease_owner_process_registered_at as number | null,
      lease_owner_process_start_time:
        r.lease_owner_process_start_time as number | null,
      lease_owner_daemon_discovery_root:
        r.lease_owner_daemon_discovery_root as string | null,
      lease_owner_daemon_checkout_root:
        r.lease_owner_daemon_checkout_root as string | null,
      lease_owner_daemon_state_root:
        r.lease_owner_daemon_state_root as string | null,
      lease_owner_daemon_bin: r.lease_owner_daemon_bin as string | null,
      lease_owner_daemon_authority_rank:
        r.lease_owner_daemon_authority_rank as string | null,
      most_recent_inbound_conversation_id:
        r.most_recent_inbound_conversation_id as ConversationId | null,
      account_label_scope: (r.account_label_scope as string | null) ?? null,
      status: r.status as Session["status"],
    };
  }
}

function isSqliteUniqueViolation(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const sqliteError = error as { code?: string; errcode?: number };
  return (
    sqliteError.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    sqliteError.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    sqliteError.errcode === 2067 ||
    sqliteError.errcode === 1555
  );
}

export async function openSqliteStorage(path: string): Promise<SqliteStorage> {
  return SqliteStorage.open(path);
}

function isConstraintError(error: unknown): boolean {
  const sqliteError = error as { code?: string; errcode?: number; errstr?: string };
  return (
    sqliteError.code === "SQLITE_CONSTRAINT" ||
    sqliteError.code === "ERR_SQLITE_CONSTRAINT" ||
    (sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === 2067) ||
    sqliteError.errstr === "constraint failed"
  );
}

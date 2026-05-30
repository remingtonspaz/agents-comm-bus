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
    this.db
      .prepare(`
        INSERT INTO account_registrations (
          schema_version, project, comm, agent, account_label, bot_user_id,
          credentials_ref, bot_username, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, comm, agent, account_label) DO UPDATE SET
          bot_user_id = excluded.bot_user_id,
          credentials_ref = excluded.credentials_ref,
          bot_username = excluded.bot_username,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json
      `)
      .run(
        rec.schema_version,
        rec.project,
        rec.comm,
        rec.agent,
        rec.account_label,
        rec.bot_user_id,
        rec.credentials_ref,
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

  async listAccountRegistrations(filter: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  } = {}): Promise<AccountRegistration[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const key of ["project", "comm", "agent"] as const) {
      if (filter[key] !== undefined) {
        clauses.push(`${key} = ?`);
        params.push(filter[key]);
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
      .run(project, comm, agent, account_label);
  }

  async upsertConversation(rec: Conversation): Promise<ConversationId> {
    this.db
      .prepare(`
        INSERT INTO conversations (
          schema_version, project, comm, account_label, bot_user_id, chat_native_id,
          thread_native_id, conversation_id, agent, last_inbound_at,
          last_outbound_at, last_message_id, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, agent, comm, account_label, chat_native_id, thread_native_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
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
        rec.account_label,
        rec.bot_user_id,
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
    return rec.conversation_id;
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE conversation_id = ?")
      .get(id);
    return row ? this.conversationFromRow(row) : null;
  }

  async findConversation(pk: {
    project: string;
    agent: AgentId;
    comm: CommId;
    account_label: string;
    bot_user_id?: string | null;
    chat_native_id: string;
    thread_native_id: string | null;
  }): Promise<Conversation | null> {
    if (pk.bot_user_id) {
      const byBot = this.db
        .prepare(`
          SELECT * FROM conversations
          WHERE project = ? AND agent = ? AND comm = ? AND bot_user_id = ?
            AND chat_native_id = ? AND thread_native_id = ?
        `)
        .get(
          pk.project,
          pk.agent,
          pk.comm,
          pk.bot_user_id,
          pk.chat_native_id,
          dbThreadId(pk.thread_native_id),
        );
      if (byBot) return this.conversationFromRow(byBot);
    }

    const row = this.db
      .prepare(`
        SELECT * FROM conversations
        WHERE project = ? AND agent = ? AND comm = ? AND account_label = ?
          AND chat_native_id = ? AND thread_native_id = ?
      `)
      .get(
        pk.project,
        pk.agent,
        pk.comm,
        pk.account_label,
        pk.chat_native_id,
        dbThreadId(pk.thread_native_id),
      );
    return row ? this.conversationFromRow(row) : null;
  }

  async listConversations(filter: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
    limit?: number;
  } = {}): Promise<Conversation[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const key of ["project", "comm", "agent"] as const) {
      if (filter[key] !== undefined) {
        clauses.push(`${key} = ?`);
        params.push(filter[key]);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit === undefined ? "" : "LIMIT ?";
    if (filter.limit !== undefined) params.push(filter.limit);
    const rows = this.db
      .prepare(`SELECT * FROM conversations ${where} ORDER BY created_at DESC ${limit}`)
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

  async upsertSession(rec: Session): Promise<void> {
    this.db
      .prepare(`
        INSERT INTO sessions (
          schema_version, session_id, agent, project, created_at,
          lease_holder_connection_id, lease_acquired_at, lease_released_at,
          lease_owner_process_pid, lease_owner_process_label,
          lease_owner_process_registered_at,
          most_recent_inbound_conversation_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent = excluded.agent,
          project = excluded.project,
          status = excluded.status
      `)
      .run(
        rec.schema_version,
        rec.session_id,
        rec.agent,
        rec.project,
        rec.created_at,
        rec.lease_holder_connection_id,
        rec.lease_acquired_at,
        rec.lease_released_at,
        rec.lease_owner_process_pid,
        rec.lease_owner_process_label,
        rec.lease_owner_process_registered_at,
        rec.most_recent_inbound_conversation_id,
        rec.status,
      );
  }

  async acquireSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
    owner?: SessionLeaseOwner,
  ): Promise<boolean> {
    try {
      const result = this.db
        .prepare(`
          UPDATE sessions
          SET lease_holder_connection_id = ?,
              lease_acquired_at = ?,
              lease_released_at = NULL,
              lease_owner_process_pid = ?,
              lease_owner_process_label = ?,
              lease_owner_process_registered_at = ?
          WHERE session_id = ?
            AND (lease_holder_connection_id IS NULL OR lease_holder_connection_id = ?)
        `)
        .run(
          connection_id,
          at,
          owner?.process_pid ?? null,
          owner?.process_label ?? null,
          owner?.process_pid ? at : null,
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
            lease_owner_process_registered_at = NULL
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `)
      .run(at, session, connection_id);
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
  } = {}): Promise<Session[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.project !== undefined) {
      where.push("project = ?");
      params.push(filter.project);
    }
    if (filter.agent !== undefined) {
      where.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
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
      project: r.project as string,
      comm: r.comm as CommId,
      agent: r.agent as AgentId,
      account_label: r.account_label as string,
      bot_user_id: r.bot_user_id as string,
      credentials_ref: r.credentials_ref as string,
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
      account_label: r.account_label as string,
      bot_user_id: (r.bot_user_id as string | null) ?? null,
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
      most_recent_inbound_conversation_id:
        r.most_recent_inbound_conversation_id as ConversationId | null,
      status: r.status as Session["status"],
    };
  }
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

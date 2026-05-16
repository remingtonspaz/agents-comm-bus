import { createRequire } from "node:module";

import type { ResolvedDecision } from "../../../agents-comm-bus-core/dist/queries.js";
import type {
  AccountRegistration,
  Conversation,
  QueryRecord,
  Session,
} from "../../../agents-comm-bus-core/dist/records/index.js";
import type { Storage } from "../../../agents-comm-bus-core/dist/storage/storage.js";
import type {
  AgentId,
  CommId,
  ConversationId,
  MessageId,
  QueryId,
  SessionId,
} from "../../../agents-comm-bus-core/dist/types.js";
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
          schema_version, project, comm, account_label, chat_native_id,
          thread_native_id, conversation_id, agent, last_inbound_at,
          last_outbound_at, last_message_id, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, comm, account_label, chat_native_id, thread_native_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          agent = excluded.agent,
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
    comm: CommId;
    account_label: string;
    chat_native_id: string;
    thread_native_id: string | null;
  }): Promise<Conversation | null> {
    const row = this.db
      .prepare(`
        SELECT * FROM conversations
        WHERE project = ? AND comm = ? AND account_label = ?
          AND chat_native_id = ? AND thread_native_id = ?
      `)
      .get(
        pk.project,
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
          most_recent_inbound_conversation_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent = excluded.agent,
          project = excluded.project,
          lease_holder_connection_id = excluded.lease_holder_connection_id,
          lease_acquired_at = excluded.lease_acquired_at,
          lease_released_at = excluded.lease_released_at,
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
        rec.most_recent_inbound_conversation_id,
        rec.status,
      );
  }

  async acquireSessionLease(
    session: SessionId,
    connection_id: string,
    at: number,
  ): Promise<boolean> {
    try {
      const result = this.db
        .prepare(`
          UPDATE sessions
          SET lease_holder_connection_id = ?,
              lease_acquired_at = ?,
              lease_released_at = NULL
          WHERE session_id = ?
            AND (lease_holder_connection_id IS NULL OR lease_holder_connection_id = ?)
        `)
        .run(connection_id, at, session, connection_id) as { changes?: number };
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
            lease_released_at = ?
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

  async close(): Promise<void> {
    this.db.close();
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

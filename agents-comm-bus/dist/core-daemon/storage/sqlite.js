import { createRequire } from "node:module";
import { normalizeProjectPath } from "../project-path.js";
import { runStorageMigrations } from "./schema/runner.js";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
function encodeJson(value) {
    return value === undefined || value === null ? null : JSON.stringify(value);
}
function decodeJson(value) {
    return typeof value === "string" ? JSON.parse(value) : null;
}
function dbThreadId(value) {
    return value ?? "";
}
function recordThreadId(value) {
    return value === "" ? null : value;
}
export class SqliteStorage {
    db;
    constructor(db) {
        this.db = db;
    }
    static async open(path) {
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
    async putAccountRegistration(rec) {
        const project = normalizeProjectPath(rec.project);
        this.db
            .prepare(`
        INSERT INTO account_registrations (
          schema_version, registration_id, project, comm, agent, account_label,
          bot_user_id, credentials_ref, bot_username, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, comm, agent, account_label) DO UPDATE SET
          bot_user_id = excluded.bot_user_id,
          credentials_ref = excluded.credentials_ref,
          bot_username = excluded.bot_username,
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json
      `)
            .run(rec.schema_version, rec.registration_id ?? null, project, rec.comm, rec.agent, rec.account_label, rec.bot_user_id, rec.credentials_ref, rec.bot_username ?? null, rec.created_at, rec.updated_at, encodeJson(rec.metadata));
    }
    async getAccountByBot(comm, bot_user_id) {
        const row = this.db
            .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
            .get(comm, bot_user_id);
        return row ? this.accountFromRow(row) : null;
    }
    async listAccountRegistrations(filter = {}) {
        const normalizedFilter = {
            ...filter,
            project: filter.project === undefined ? undefined : normalizeProjectPath(filter.project),
        };
        const clauses = [];
        const params = [];
        for (const key of ["project", "comm", "agent"]) {
            if (normalizedFilter[key] !== undefined) {
                clauses.push(`${key} = ?`);
                params.push(normalizedFilter[key]);
            }
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM account_registrations ${where} ORDER BY created_at, account_label`)
            .all(...params);
        return rows.map((row) => this.accountFromRow(row));
    }
    async deleteAccountRegistration(project, comm, agent, account_label) {
        this.db
            .prepare(`
        DELETE FROM account_registrations
        WHERE project = ? AND comm = ? AND agent = ? AND account_label = ?
      `)
            .run(normalizeProjectPath(project), comm, agent, account_label);
    }
    async updateAccountRegistrationToken(input) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const previousRow = this.db
                .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
                .get(input.comm, input.current_bot_user_id);
            if (!previousRow) {
                throw new Error(`no account registration found for (comm=${input.comm}, bot-id=${input.current_bot_user_id})`);
            }
            const previous = this.accountFromRow(previousRow);
            const botChanged = input.current_bot_user_id !== input.new_bot_user_id;
            if (botChanged) {
                const existing = this.db
                    .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
                    .get(input.comm, input.new_bot_user_id);
                if (existing) {
                    const row = this.accountFromRow(existing);
                    throw new Error(`${input.comm} bot id ${input.new_bot_user_id} is already registered as ` +
                        `project=${row.project}, agent=${row.agent}, account_label=${row.account_label}`);
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
                    const row = allowlistConflict;
                    throw new Error(`cannot move ${input.comm} bot id ${input.current_bot_user_id} to ` +
                        `${input.new_bot_user_id}: allowlist row already exists for sender ` +
                        `${row.sender_id ?? "(unknown)"}`);
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
                .run(input.new_bot_user_id, input.credentials_ref, input.bot_username ?? null, input.updated_at, input.comm, input.current_bot_user_id);
            if (Number(accountResult.changes ?? 0) !== 1) {
                throw new Error(`failed to update account registration for ${input.comm}/${input.current_bot_user_id}`);
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
                    .run(input.new_bot_user_id, input.comm, input.current_bot_user_id);
                migratedAllowlistRows = Number(allowlistResult.changes ?? 0);
                const conversationResult = this.db
                    .prepare(`
            UPDATE conversations
            SET bot_user_id = ?
            WHERE comm = ? AND bot_user_id = ?
          `)
                    .run(input.new_bot_user_id, input.comm, input.current_bot_user_id);
                migratedConversationRows = Number(conversationResult.changes ?? 0);
            }
            const nextRow = this.db
                .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
                .get(input.comm, input.new_bot_user_id);
            if (!nextRow) {
                throw new Error(`updated account registration not found for ${input.comm}/${input.new_bot_user_id}`);
            }
            this.db.exec("COMMIT");
            return {
                previous,
                next: this.accountFromRow(nextRow),
                bot_changed: botChanged,
                migrated_allowlist_rows: migratedAllowlistRows,
                migrated_conversation_rows: migratedConversationRows,
            };
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    async updateAccountRegistrationLabel(input) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const previousRow = this.db
                .prepare("SELECT * FROM account_registrations WHERE comm = ? AND bot_user_id = ?")
                .get(input.comm, input.bot_user_id);
            if (!previousRow) {
                throw new Error(`no account registration found for (comm=${input.comm}, bot-id=${input.bot_user_id})`);
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
                throw new Error(`account label ${input.account_label} is already registered for ` +
                    `project=${row.project}, comm=${row.comm}, agent=${row.agent} ` +
                    `as bot id ${row.bot_user_id}`);
            }
            const result = this.db
                .prepare(`
          UPDATE account_registrations
          SET account_label = ?,
              updated_at = ?
          WHERE registration_id = ?
        `)
                .run(input.account_label, input.updated_at, previous.registration_id);
            if (Number(result.changes ?? 0) !== 1) {
                throw new Error(`failed to relabel account registration for ${input.comm}/${input.bot_user_id}`);
            }
            const nextRow = this.db
                .prepare("SELECT * FROM account_registrations WHERE registration_id = ?")
                .get(previous.registration_id);
            if (!nextRow) {
                throw new Error(`updated account registration not found for ${previous.registration_id}`);
            }
            this.db.exec("COMMIT");
            return { previous, next: this.accountFromRow(nextRow) };
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    async upsertConversation(rec) {
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
            let result;
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
                    .run(rec.bot_user_id, rec.registration_id ?? null, rec.last_inbound_at, rec.last_outbound_at, rec.last_message_id, encodeJson(rec.metadata), existingId);
                result = existingId;
            }
            else {
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
                    .run(rec.schema_version, rec.project, rec.comm, rec.bot_user_id, rec.registration_id ?? null, rec.chat_native_id, dbThreadId(rec.thread_native_id), rec.conversation_id, rec.agent, rec.last_inbound_at, rec.last_outbound_at, rec.last_message_id, rec.created_at, encodeJson(rec.metadata));
                result = rec.conversation_id;
            }
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
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
    findExistingConversationId(rec) {
        if (rec.registration_id == null)
            return null;
        const byReg = this.db
            .prepare(`
        SELECT conversation_id FROM conversations
        WHERE registration_id = ? AND chat_native_id = ? AND thread_native_id = ?
      `)
            .get(rec.registration_id, rec.chat_native_id, dbThreadId(rec.thread_native_id));
        return byReg?.conversation_id ?? null;
    }
    // AGE-22: a conversation's account_label is resolved purely from its owning
    // registration (registration_id -> account_registrations). conversations no
    // longer stores account_label (the column was dropped in migration 008), so a
    // relabel is visible immediately on every read and no behavior path keys off a
    // mutable stored label. The join misses only for an orphan/retired
    // registration; the row mapper surfaces "" in that case.
    conversationSelect = `
    SELECT c.*, ar.account_label AS effective_account_label
    FROM conversations c
    LEFT JOIN account_registrations ar ON ar.registration_id = c.registration_id
  `;
    async getConversation(id) {
        const row = this.db
            .prepare(`${this.conversationSelect} WHERE c.conversation_id = ?`)
            .get(id);
        return row ? this.conversationFromRow(row) : null;
    }
    async findConversation(pk) {
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
            if (byReg)
                return this.conversationFromRow(byReg);
        }
        if (pk.bot_user_id) {
            const byBot = this.db
                .prepare(`
          ${this.conversationSelect}
          WHERE c.project = ? AND c.agent = ? AND c.comm = ? AND c.bot_user_id = ?
            AND c.chat_native_id = ? AND c.thread_native_id = ?
        `)
                .get(normalizeProjectPath(pk.project), pk.agent, pk.comm, pk.bot_user_id, pk.chat_native_id, dbThreadId(pk.thread_native_id));
            if (byBot)
                return this.conversationFromRow(byBot);
        }
        return null;
    }
    async listConversations(filter = {}) {
        const normalizedFilter = {
            ...filter,
            project: filter.project === undefined ? undefined : normalizeProjectPath(filter.project),
        };
        const clauses = [];
        const params = [];
        for (const key of ["project", "comm", "agent"]) {
            if (normalizedFilter[key] !== undefined) {
                clauses.push(`c.${key} = ?`);
                params.push(normalizedFilter[key]);
            }
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = filter.limit === undefined ? "" : "LIMIT ?";
        if (filter.limit !== undefined)
            params.push(filter.limit);
        const rows = this.db
            .prepare(`${this.conversationSelect} ${where} ORDER BY c.created_at DESC ${limit}`)
            .all(...params);
        return rows.map((row) => this.conversationFromRow(row));
    }
    async touchConversationInbound(id, at, message_id) {
        this.db
            .prepare(`
        UPDATE conversations
        SET last_inbound_at = ?, last_message_id = ?
        WHERE conversation_id = ?
      `)
            .run(at, message_id, id);
    }
    async touchConversationOutbound(id, at, message_id) {
        this.db
            .prepare(`
        UPDATE conversations
        SET last_outbound_at = ?, last_message_id = ?
        WHERE conversation_id = ?
      `)
            .run(at, message_id, id);
    }
    async insertQuery(rec) {
        this.db
            .prepare(`
        INSERT INTO queries (
          schema_version, query_id, agent, session_id, kind, prompt_text,
          created_at, ttl_seconds, origin_chat_id, source_message_id,
          resolved_at, resolution_json, options_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
            .run(rec.schema_version, rec.query_id, rec.agent, rec.session, rec.kind, rec.prompt_text, rec.created_at, rec.ttl_seconds, rec.origin_chat_id, rec.source_message_id, rec.resolved_at, encodeJson(rec.resolution), rec.options_json);
    }
    async resolveQuery(query_id, resolution, resolved_at) {
        const result = this.db
            .prepare(`
        UPDATE queries
        SET resolved_at = ?, resolution_json = ?
        WHERE query_id = ? AND resolved_at IS NULL
      `)
            .run(resolved_at, encodeJson(resolution), query_id);
        return result.changes === 1;
    }
    async getOpenQueryForSession(session) {
        const row = this.db
            .prepare("SELECT * FROM queries WHERE session_id = ? AND resolved_at IS NULL")
            .get(session);
        return row ? this.queryFromRow(row) : null;
    }
    async getOpenQueryByConversation(conversation_id) {
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
    async getQuery(query_id) {
        const row = this.db
            .prepare("SELECT * FROM queries WHERE query_id = ?")
            .get(query_id);
        return row ? this.queryFromRow(row) : null;
    }
    async getOpenQueryById(query_id) {
        const row = this.db
            .prepare("SELECT * FROM queries WHERE query_id = ? AND resolved_at IS NULL")
            .get(query_id);
        return row ? this.queryFromRow(row) : null;
    }
    async listOpenQueriesForSession(session) {
        const rows = this.db
            .prepare(`
        SELECT * FROM queries
        WHERE session_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
      `)
            .all(session);
        return rows.map((row) => this.queryFromRow(row));
    }
    async listOpenQueriesByConversation(conversation_id) {
        const rows = this.db
            .prepare(`
        SELECT * FROM queries
        WHERE origin_chat_id = ? AND resolved_at IS NULL
        ORDER BY created_at ASC
      `)
            .all(conversation_id);
        return rows.map((row) => this.queryFromRow(row));
    }
    async setQuerySourceMessage(query_id, source_message_id) {
        const result = this.db
            .prepare("UPDATE queries SET source_message_id = ? WHERE query_id = ? AND resolved_at IS NULL")
            .run(source_message_id, query_id);
        return Number(result.changes ?? 0) > 0;
    }
    async updateQueryKind(query_id, kind) {
        const result = this.db
            .prepare("UPDATE queries SET kind = ? WHERE query_id = ? AND resolved_at IS NULL")
            .run(kind, query_id);
        return Number(result.changes ?? 0) > 0;
    }
    async supersedeOpenQueriesForSession(session_id, now) {
        const result = this.db
            .prepare(`
        UPDATE queries
        SET resolved_at = ?,
            resolution_json = ?
        WHERE session_id = ?
          AND resolved_at IS NULL
      `)
            .run(now, JSON.stringify({ kind: "superseded" }), session_id);
        return Number(result.changes ?? 0);
    }
    async cancelOpenQuery(query_id, now) {
        const result = this.db
            .prepare(`
        UPDATE queries
        SET resolved_at = ?,
            resolution_json = ?
        WHERE query_id = ?
          AND resolved_at IS NULL
      `)
            .run(now, JSON.stringify({ kind: "cancelled" }), query_id);
        return Number(result.changes ?? 0) > 0;
    }
    async upsertSession(rec) {
        const project = normalizeProjectPath(rec.project);
        this.db
            .prepare(`
        INSERT INTO sessions (
          schema_version, session_id, agent, project, created_at,
          lease_holder_connection_id, lease_acquired_at, lease_released_at,
          lease_owner_process_pid, lease_owner_process_label,
          lease_owner_process_registered_at,
          lease_owner_daemon_discovery_root, lease_owner_daemon_checkout_root,
          lease_owner_daemon_state_root, lease_owner_daemon_bin,
          lease_owner_daemon_authority_rank,
          most_recent_inbound_conversation_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent = excluded.agent,
          project = excluded.project,
          status = excluded.status
      `)
            .run(rec.schema_version, rec.session_id, rec.agent, project, rec.created_at, rec.lease_holder_connection_id, rec.lease_acquired_at, rec.lease_released_at, rec.lease_owner_process_pid, rec.lease_owner_process_label, rec.lease_owner_process_registered_at, rec.lease_owner_daemon_discovery_root, rec.lease_owner_daemon_checkout_root, rec.lease_owner_daemon_state_root, rec.lease_owner_daemon_bin, rec.lease_owner_daemon_authority_rank, rec.most_recent_inbound_conversation_id, rec.status);
    }
    async acquireSessionLease(session, connection_id, at, owner) {
        try {
            const result = this.db
                .prepare(`
          UPDATE sessions
          SET lease_holder_connection_id = ?,
              lease_acquired_at = ?,
              lease_released_at = NULL,
              lease_owner_process_pid = ?,
              lease_owner_process_label = ?,
              lease_owner_process_registered_at = ?,
              lease_owner_daemon_discovery_root = ?,
              lease_owner_daemon_checkout_root = ?,
              lease_owner_daemon_state_root = ?,
              lease_owner_daemon_bin = ?,
              lease_owner_daemon_authority_rank = ?
          WHERE session_id = ?
            AND (lease_holder_connection_id IS NULL OR lease_holder_connection_id = ?)
        `)
                .run(connection_id, at, owner?.process_pid ?? null, owner?.process_label ?? null, owner?.process_pid ? at : null, owner?.daemon?.discovery_root ?? null, owner?.daemon?.checkout_root ?? null, owner?.daemon?.state_root ?? null, owner?.daemon?.daemon_bin ?? null, owner?.daemon?.authority_rank ?? null, session, connection_id);
            return result.changes === 1;
        }
        catch (error) {
            if (isConstraintError(error))
                return false;
            throw error;
        }
    }
    async releaseSessionLease(session, connection_id, at) {
        this.db
            .prepare(`
        UPDATE sessions
        SET lease_holder_connection_id = NULL,
            lease_released_at = ?,
            lease_owner_process_pid = NULL,
            lease_owner_process_label = NULL,
            lease_owner_process_registered_at = NULL,
            lease_owner_daemon_discovery_root = NULL,
            lease_owner_daemon_checkout_root = NULL,
            lease_owner_daemon_state_root = NULL,
            lease_owner_daemon_bin = NULL,
            lease_owner_daemon_authority_rank = NULL
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `)
            .run(at, session, connection_id);
    }
    async releaseSessionConnectionLeasePreservingOwner(session, connection_id, at) {
        this.db
            .prepare(`
        UPDATE sessions
        SET lease_holder_connection_id = NULL,
            lease_released_at = ?
        WHERE session_id = ? AND lease_holder_connection_id = ?
      `)
            .run(at, session, connection_id);
    }
    async getSession(session) {
        const row = this.db
            .prepare("SELECT * FROM sessions WHERE session_id = ?")
            .get(session);
        return row ? this.sessionFromRow(row) : null;
    }
    async listSessions(filter = {}) {
        const where = [];
        const params = [];
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
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM sessions ${whereClause} ORDER BY created_at DESC`)
            .all(...params);
        return rows.map((row) => this.sessionFromRow(row));
    }
    async setSessionMostRecentInbound(session, conversation_id) {
        this.db
            .prepare(`
        UPDATE sessions
        SET most_recent_inbound_conversation_id = ?
        WHERE session_id = ?
      `)
            .run(conversation_id, session);
    }
    async addAllowlistGlobal(rec) {
        this.db
            .prepare(`
        INSERT INTO allowlist_global (comm, sender_id, added_at, added_by, note)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(comm, sender_id) DO NOTHING
      `)
            .run(rec.comm, rec.sender_id, rec.added_at, rec.added_by ?? null, rec.note ?? null);
    }
    async removeAllowlistGlobal(comm, sender_id) {
        this.db
            .prepare("DELETE FROM allowlist_global WHERE comm = ? AND sender_id = ?")
            .run(comm, sender_id);
    }
    async listAllowlistGlobal(filter = {}) {
        const clauses = [];
        const params = [];
        if (filter.comm !== undefined) {
            clauses.push("comm = ?");
            params.push(filter.comm);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = this.db
            .prepare(`SELECT * FROM allowlist_global ${where} ORDER BY comm, sender_id`)
            .all(...params);
        return rows.map((row) => this.allowlistGlobalFromRow(row));
    }
    async addAllowlistPerBot(rec) {
        this.db
            .prepare(`
        INSERT INTO allowlist_per_bot
          (comm, bot_user_id, sender_id, added_at, added_by, note)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(comm, bot_user_id, sender_id) DO NOTHING
      `)
            .run(rec.comm, rec.bot_user_id, rec.sender_id, rec.added_at, rec.added_by ?? null, rec.note ?? null);
    }
    async removeAllowlistPerBot(comm, bot_user_id, sender_id) {
        this.db
            .prepare("DELETE FROM allowlist_per_bot WHERE comm = ? AND bot_user_id = ? AND sender_id = ?")
            .run(comm, bot_user_id, sender_id);
    }
    async listAllowlistPerBot(filter = {}) {
        const clauses = [];
        const params = [];
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
            .prepare(`SELECT * FROM allowlist_per_bot ${where} ORDER BY comm, bot_user_id, sender_id`)
            .all(...params);
        return rows.map((row) => this.allowlistPerBotFromRow(row));
    }
    async recordPendingInboundDelivery(row) {
        const project = normalizeProjectPath(row.project);
        this.db
            .prepare(`
        INSERT INTO pending_inbound_deliveries (
          conversation_id, message_id, comm, account, project, agent, enqueued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, message_id, comm, account) DO NOTHING
      `)
            .run(row.conversation_id, row.message_id, row.comm, row.account, project, row.agent, row.enqueued_at);
    }
    async listPendingInboundDeliveries(filter) {
        const project = normalizeProjectPath(filter.project);
        const rows = this.db
            .prepare(`
        SELECT * FROM pending_inbound_deliveries
        WHERE project = ? AND agent = ?
        ORDER BY enqueued_at, conversation_id, message_id
      `)
            .all(project, filter.agent);
        return rows.map((row) => this.pendingInboundDeliveryFromRow(row));
    }
    async acknowledgePendingInboundDeliveries(keys) {
        if (keys.length === 0)
            return;
        const stmt = this.db.prepare(`
      DELETE FROM pending_inbound_deliveries
      WHERE conversation_id = ? AND message_id = ? AND comm = ? AND account = ?
    `);
        for (const key of keys) {
            stmt.run(key.conversation_id, key.message_id, key.comm, key.account);
        }
    }
    async close() {
        this.db.close();
    }
    allowlistGlobalFromRow(row) {
        const r = row;
        return {
            comm: r.comm,
            sender_id: r.sender_id,
            added_at: r.added_at,
            added_by: r.added_by ?? undefined,
            note: r.note ?? undefined,
        };
    }
    allowlistPerBotFromRow(row) {
        const r = row;
        return {
            comm: r.comm,
            bot_user_id: r.bot_user_id,
            sender_id: r.sender_id,
            added_at: r.added_at,
            added_by: r.added_by ?? undefined,
            note: r.note ?? undefined,
        };
    }
    accountFromRow(row) {
        const r = row;
        return {
            schema_version: r.schema_version,
            registration_id: r.registration_id,
            project: r.project,
            comm: r.comm,
            agent: r.agent,
            account_label: r.account_label,
            bot_user_id: r.bot_user_id,
            credentials_ref: r.credentials_ref,
            bot_username: r.bot_username ?? undefined,
            created_at: r.created_at,
            updated_at: r.updated_at,
            metadata: decodeJson(r.metadata_json) ?? undefined,
        };
    }
    conversationFromRow(row) {
        const r = row;
        return {
            schema_version: r.schema_version,
            project: r.project,
            comm: r.comm,
            // AGE-22: registration-resolved current label (see conversationSelect).
            // "" when the join misses (orphan / retired registration).
            account_label: (r.effective_account_label ?? ""),
            bot_user_id: r.bot_user_id ?? null,
            registration_id: r.registration_id ?? null,
            chat_native_id: r.chat_native_id,
            thread_native_id: recordThreadId(r.thread_native_id),
            conversation_id: r.conversation_id,
            agent: r.agent,
            last_inbound_at: r.last_inbound_at,
            last_outbound_at: r.last_outbound_at,
            last_message_id: r.last_message_id,
            created_at: r.created_at,
            metadata: decodeJson(r.metadata_json) ?? undefined,
        };
    }
    queryFromRow(row) {
        const r = row;
        return {
            schema_version: r.schema_version,
            query_id: r.query_id,
            agent: r.agent,
            session: r.session_id,
            kind: r.kind,
            prompt_text: r.prompt_text,
            created_at: r.created_at,
            ttl_seconds: r.ttl_seconds,
            origin_chat_id: r.origin_chat_id,
            source_message_id: r.source_message_id,
            resolved_at: r.resolved_at,
            resolution: decodeJson(r.resolution_json),
            options_json: r.options_json,
        };
    }
    pendingInboundDeliveryFromRow(row) {
        const r = row;
        return {
            conversation_id: r.conversation_id,
            message_id: r.message_id,
            comm: r.comm,
            account: r.account,
            project: r.project,
            agent: r.agent,
            enqueued_at: r.enqueued_at,
        };
    }
    sessionFromRow(row) {
        const r = row;
        return {
            schema_version: r.schema_version,
            session_id: r.session_id,
            agent: r.agent,
            project: r.project,
            created_at: r.created_at,
            lease_holder_connection_id: r.lease_holder_connection_id,
            lease_acquired_at: r.lease_acquired_at,
            lease_released_at: r.lease_released_at,
            lease_owner_process_pid: r.lease_owner_process_pid,
            lease_owner_process_label: r.lease_owner_process_label,
            lease_owner_process_registered_at: r.lease_owner_process_registered_at,
            lease_owner_daemon_discovery_root: r.lease_owner_daemon_discovery_root,
            lease_owner_daemon_checkout_root: r.lease_owner_daemon_checkout_root,
            lease_owner_daemon_state_root: r.lease_owner_daemon_state_root,
            lease_owner_daemon_bin: r.lease_owner_daemon_bin,
            lease_owner_daemon_authority_rank: r.lease_owner_daemon_authority_rank,
            most_recent_inbound_conversation_id: r.most_recent_inbound_conversation_id,
            status: r.status,
        };
    }
}
export async function openSqliteStorage(path) {
    return SqliteStorage.open(path);
}
function isConstraintError(error) {
    const sqliteError = error;
    return (sqliteError.code === "SQLITE_CONSTRAINT" ||
        sqliteError.code === "ERR_SQLITE_CONSTRAINT" ||
        (sqliteError.code === "ERR_SQLITE_ERROR" && sqliteError.errcode === 2067) ||
        sqliteError.errstr === "constraint failed");
}
//# sourceMappingURL=sqlite.js.map
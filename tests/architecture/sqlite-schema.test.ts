import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStorage } from "../../agents-comm-bus/src/storage/sqlite.js";
import type { AccountRegistration, Conversation, QueryRecord, Session } from "../../agents-comm-bus-core/src/records/index.js";
import type { AccountId, AgentId, CommId, ConversationId, MessageId, QueryId, SessionId } from "../../agents-comm-bus-core/src/types.js";

async function withStorage<T>(test: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-sqlite-"));
  try {
    return await test(join(dir, "storage.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function account(overrides: Partial<AccountRegistration> = {}): AccountRegistration {
  return {
    schema_version: 1,
    project: "project-a",
    comm: "telegram" as CommId,
    agent: "claude" as AgentId,
    account_label: "main",
    bot_user_id: "bot-1",
    credentials_ref: "keyring://telegram/main",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    schema_version: 1,
    session_id: "session-1" as SessionId,
    agent: "claude" as AgentId,
    project: "project-a",
    created_at: 1,
    lease_holder_connection_id: null,
    lease_acquired_at: null,
    lease_released_at: null,
    most_recent_inbound_conversation_id: null,
    status: "active",
    ...overrides,
  };
}

function query(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    schema_version: 1,
    query_id: "query-1" as QueryId,
    agent: "claude" as AgentId,
    session: "session-1" as SessionId,
    kind: "approval",
    prompt_text: "Allow?",
    created_at: 2,
    ttl_seconds: 60,
    origin_chat_id: null,
    source_message_id: null,
    resolved_at: null,
    resolution: null,
    options_json: null,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    schema_version: 1,
    project: "project-a",
    comm: "telegram" as CommId,
    account_label: "main",
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: "conversation-1" as ConversationId,
    agent: "claude" as AgentId,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_id: null,
    created_at: 1,
    ...overrides,
  };
}

describe("SQLite storage schema", () => {
  it("enforces one account registration per (comm, bot_user_id)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.putAccountRegistration(account());

      await assert.rejects(
        storage.putAccountRegistration(
          account({
            project: "project-b",
            agent: "codex" as AgentId,
            account_label: "other",
          }),
        ),
      );

      await storage.close();
    });
  });

  it("enforces one open query per session with a partial unique index", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.upsertSession(session());
      await storage.insertQuery(query());

      await assert.rejects(
        storage.insertQuery(query({ query_id: "query-2" as QueryId })),
      );

      const resolved = await storage.resolveQuery(
        "query-1" as QueryId,
        {
          query_id: "query-1" as QueryId,
          decision: "allow",
          decided_by_sender_id: "user-1",
          decided_in_chat: {
            comm: "telegram" as CommId,
            account: "main" as AccountId,
            chat_native_id: "chat-1",
          },
          decided_at: 3,
        },
        3,
      );
      assert.equal(resolved, true);

      await storage.insertQuery(query({ query_id: "query-2" as QueryId }));
      assert.equal((await storage.getOpenQueryForSession("session-1" as SessionId))?.query_id, "query-2");

      await storage.close();
    });
  });

  it("keeps conversations distinct by agent when account labels match", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.upsertConversation(conversation());
      await storage.upsertConversation(conversation({
        conversation_id: "conversation-2" as ConversationId,
        agent: "codex" as AgentId,
        last_message_id: "telegram:2" as MessageId,
      }));

      const claude = await storage.findConversation({
        project: "project-a",
        agent: "claude" as AgentId,
        comm: "telegram" as CommId,
        account_label: "main",
        chat_native_id: "chat-1",
        thread_native_id: null,
      });
      const codex = await storage.findConversation({
        project: "project-a",
        agent: "codex" as AgentId,
        comm: "telegram" as CommId,
        account_label: "main",
        chat_native_id: "chat-1",
        thread_native_id: null,
      });

      assert.equal(claude?.conversation_id, "conversation-1");
      assert.equal(codex?.conversation_id, "conversation-2");

      await storage.close();
    });
  });
});

describe("allowlist storage (migration v3)", () => {
  const TELEGRAM = "telegram" as CommId;

  it("inserts and lists global allowlist rows; PK collisions are idempotent", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "8296218244",
        added_at: 1,
        added_by: "cli",
        note: "human operator",
      });
      // PK collision must not throw and must not add a duplicate.
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "8296218244",
        added_at: 999,
        added_by: "cli",
      });
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "8950482517",
        added_at: 2,
      });

      const rows = await storage.listAllowlistGlobal({ comm: TELEGRAM });
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r) => r.sender_id).sort(),
        ["8296218244", "8950482517"],
      );

      await storage.close();
    });
  });

  it("removes a global allowlist row by (comm, sender_id)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "8296218244",
        added_at: 1,
      });
      await storage.removeAllowlistGlobal(TELEGRAM, "8296218244");
      const rows = await storage.listAllowlistGlobal({ comm: TELEGRAM });
      assert.equal(rows.length, 0);
      // Removing a non-existent row is a no-op (no throw).
      await storage.removeAllowlistGlobal(TELEGRAM, "8296218244");
      await storage.close();
    });
  });

  it("keeps per-bot allowlist rows distinct by bot_user_id even when sender_id collides", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517", // Claude bot
        sender_id: "8988792099",   // Codex bot
        added_at: 1,
      });
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8988792099", // Codex bot
        sender_id: "8988792099",   // Codex bot reaching itself — distinct row
        added_at: 2,
      });
      // PK collision on the FIRST row is idempotent.
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
        sender_id: "8988792099",
        added_at: 99,
        note: "would-be replacement",
      });

      const claudeRows = await storage.listAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
      });
      const codexRows = await storage.listAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8988792099",
      });
      assert.equal(claudeRows.length, 1);
      assert.equal(codexRows.length, 1);
      // PK collision did not overwrite the original `added_at`.
      assert.equal(claudeRows[0].added_at, 1);
      assert.equal(claudeRows[0].note, undefined);

      await storage.close();
    });
  });

  it("removes a per-bot row by (comm, bot_user_id, sender_id) without disturbing siblings", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
        sender_id: "S1",
        added_at: 1,
      });
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
        sender_id: "S2",
        added_at: 2,
      });
      await storage.removeAllowlistPerBot(TELEGRAM, "8950482517", "S1");
      const rows = await storage.listAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sender_id, "S2");
      await storage.close();
    });
  });

  it("lists per-bot rows scoped by comm and optional bot_user_id", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
        sender_id: "S1",
        added_at: 1,
      });
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8988792099",
        sender_id: "S2",
        added_at: 2,
      });

      const allTelegram = await storage.listAllowlistPerBot({ comm: TELEGRAM });
      assert.equal(allTelegram.length, 2);

      const claudeOnly = await storage.listAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
      });
      assert.equal(claudeOnly.length, 1);
      assert.equal(claudeOnly[0].sender_id, "S1");

      await storage.close();
    });
  });
});

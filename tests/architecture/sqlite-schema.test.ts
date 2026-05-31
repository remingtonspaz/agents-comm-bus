import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import {
  SqliteMigrationRunner,
  initialMigration,
  conversationAgentIdentityMigration,
  allowlistMigration,
  sessionOwnerProcessMigration,
  conversationBotIdentityMigration,
  registrationIdentityMigration,
  registrationPkMigration,
  conversationRegistrationKeyMigration,
} from "../../core-daemon/storage/schema/runner.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type { AccountRegistration, Conversation, QueryRecord, Session } from "../../packages/core-contracts/src/records/index.js";
import type { AccountId, AgentId, CommId, ConversationId, MessageId, QueryId, SessionId } from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

async function withStorage<T>(test: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir("acb-sqlite-");
  return await test(join(dir, "storage.db"));
}

function account(overrides: Partial<AccountRegistration> = {}): AccountRegistration {
  const bot_user_id = overrides.bot_user_id ?? "bot-1";
  return {
    schema_version: 1,
    project: "project-a",
    comm: "telegram" as CommId,
    agent: "claude" as AgentId,
    account_label: "main",
    bot_user_id,
    // registration_id is NOT NULL as of migration 007; derive a unique default
    // from the (unique) bot id so fixtures that omit it still insert.
    registration_id: `reg-${bot_user_id}`,
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
    lease_owner_process_pid: null,
    lease_owner_process_label: null,
    lease_owner_process_registered_at: null,
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
  const bot_user_id = overrides.bot_user_id === undefined ? "bot-1" : overrides.bot_user_id;
  return {
    schema_version: 1,
    project: "project-a",
    comm: "telegram" as CommId,
    account_label: "main",
    bot_user_id,
    // registration_id is NOT NULL and the conversation identity as of migration
    // 008; default a unique-per-bot value so fixtures that omit it still insert.
    registration_id: `reg-${bot_user_id ?? "none"}`,
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
        bot_user_id: "bot-2",
        last_message_id: "telegram:2" as MessageId,
      }));

      const claude = await storage.findConversation({
        project: "project-a",
        agent: "claude" as AgentId,
        comm: "telegram" as CommId,
        bot_user_id: "bot-1",
        chat_native_id: "chat-1",
        thread_native_id: null,
      });
      const codex = await storage.findConversation({
        project: "project-a",
        agent: "codex" as AgentId,
        comm: "telegram" as CommId,
        bot_user_id: "bot-2",
        chat_native_id: "chat-1",
        thread_native_id: null,
      });

      assert.equal(claude?.conversation_id, "conversation-1");
      assert.equal(codex?.conversation_id, "conversation-2");
      assert.equal(claude?.bot_user_id, "bot-1");
      assert.equal(codex?.bot_user_id, "bot-2");

      await storage.close();
    });
  });

  it("resolves by registration_id even when bot_user_id is null", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.upsertConversation(conversation({ registration_id: "RX" }));
      (storage as unknown as { db: { prepare(sql: string): { run(): unknown } } })
        .db
        .prepare("UPDATE conversations SET bot_user_id = NULL")
        .run();

      // AGE-22: the stable surrogate key resolves the row regardless of
      // bot_user_id (there is no account_label lookup anymore).
      const found = await storage.findConversation({
        project: "project-a",
        agent: "claude" as AgentId,
        comm: "telegram" as CommId,
        registration_id: "RX",
        chat_native_id: "chat-1",
        thread_native_id: null,
      });

      assert.equal(found?.conversation_id, "conversation-1");
      assert.equal(found?.bot_user_id, null);

      await storage.close();
    });
  });

  it("records and clears lease owner process metadata", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.upsertSession(session());

      assert.equal(
        await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10, {
          process_pid: 12345,
          process_label: "codex",
        }),
        true,
      );
      const acquired = await storage.getSession("session-1" as SessionId);
      assert.equal(acquired?.lease_owner_process_pid, 12345);
      assert.equal(acquired?.lease_owner_process_label, "codex");
      assert.equal(acquired?.lease_owner_process_registered_at, 10);

      await storage.releaseSessionLease("session-1" as SessionId, "conn-1", 20);
      const released = await storage.getSession("session-1" as SessionId);
      assert.equal(released?.lease_holder_connection_id, null);
      assert.equal(released?.lease_owner_process_pid, null);
      assert.equal(released?.lease_owner_process_label, null);
      assert.equal(released?.lease_owner_process_registered_at, null);

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

describe("AGE-20 registration identity (phase 1)", () => {
  it("persists registration_id and returns it via getAccountByBot", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.putAccountRegistration(
        account({ registration_id: "reg-abc", bot_user_id: "bot-x" }),
      );
      const row = await storage.getAccountByBot("telegram" as CommId, "bot-x");
      assert.equal(row?.registration_id, "reg-abc");
      await storage.close();
    });
  });

  it("preserves registration_id across a bot replacement (it is the stable identity)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.putAccountRegistration(
        account({ registration_id: "reg-stable", bot_user_id: "old-bot" }),
      );
      const result = await storage.updateAccountRegistrationToken({
        comm: "telegram" as CommId,
        current_bot_user_id: "old-bot",
        new_bot_user_id: "new-bot",
        credentials_ref: "file:/tmp/new.json",
        bot_username: "newbot",
        updated_at: 2,
      });
      assert.equal(result.bot_changed, true);
      assert.equal(result.previous.registration_id, "reg-stable");
      // The bot id changed but the registration's surrogate identity did not.
      assert.equal(result.next.registration_id, "reg-stable");
      const moved = await storage.getAccountByBot("telegram" as CommId, "new-bot");
      assert.equal(moved?.registration_id, "reg-stable");
      assert.equal(moved?.bot_user_id, "new-bot");
      await storage.close();
    });
  });

  it("stores registration_id on conversations", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.upsertConversation(
        conversation({ registration_id: "reg-conv", conversation_id: "c-reg" as ConversationId }),
      );
      const found = await storage.getConversation("c-reg" as ConversationId);
      assert.equal(found?.registration_id, "reg-conv");
      await storage.close();
    });
  });
});

describe("AGE-20 conversation identity stability (phase 2)", () => {
  it("a relabel does not re-key conversation_id (stable identity, updated in place)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      // Existing conversation owned by registration R1, label "old".
      await storage.upsertConversation(
        conversation({
          registration_id: "R1",
          account_label: "old",
          conversation_id: "C1" as ConversationId,
          chat_native_id: "chat-1",
        }),
      );
      // Simulate the post-relabel inbound: SAME (registration_id, chat, thread),
      // new label, and a freshly-derived (different) conversation_id as bus builds.
      const returnedId = await storage.upsertConversation(
        conversation({
          registration_id: "R1",
          account_label: "new",
          conversation_id: "C2" as ConversationId,
          chat_native_id: "chat-1",
          last_inbound_at: 99,
        }),
      );
      // The stable id is reused — NOT re-keyed to the fresh candidate C2.
      assert.equal(returnedId, "C1");
      const c1 = await storage.getConversation("C1" as ConversationId);
      assert.equal(c1?.last_inbound_at, 99);
      // No new/duplicate row, no transcript-id split.
      assert.equal(await storage.getConversation("C2" as ConversationId), null);
      const all = await storage.listConversations({});
      assert.equal(all.length, 1);
      await storage.close();
    });
  });

  it("finds a conversation by stable registration_id even after its label changed", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.upsertConversation(
        conversation({
          registration_id: "R9",
          account_label: "before",
          conversation_id: "CC" as ConversationId,
          chat_native_id: "chat-9",
        }),
      );
      const found = await storage.findConversation({
        project: "project-a",
        agent: "claude" as AgentId,
        comm: "telegram" as CommId,
        registration_id: "R9", // the stable key resolves it
        chat_native_id: "chat-9",
        thread_native_id: null,
      });
      assert.equal(found?.conversation_id, "CC");
      await storage.close();
    });
  });

  it("the conversation upsert never overwrites conversation_id (invariant)", async () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const src = await readFile(resolve(repoRoot, "core-daemon/storage/sqlite.ts"), "utf8");
    assert.doesNotMatch(src, /conversation_id = excluded\.conversation_id/);
  });
});

describe("AGE-20 conversation surrogate identity + race (phase 3a)", () => {
  it("rejects a second registration that reuses an existing registration_id (unique index)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.putAccountRegistration(
        account({ registration_id: "reg-dup", bot_user_id: "bot-a" }),
      );
      // Different (project, agent, label) so the ON CONFLICT upsert target does
      // NOT match — the collision is on the registration_id unique index
      // (idx_account_registrations_registration_id) added in phase 1.
      await assert.rejects(
        storage.putAccountRegistration(
          account({
            registration_id: "reg-dup",
            project: "project-z",
            agent: "codex" as AgentId,
            account_label: "other",
            bot_user_id: "bot-b",
          }),
        ),
      );
      await storage.close();
    });
  });

  it("upsertConversation collapses concurrent-style same-key upserts to one stable row", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      // The transaction-wrapped find+insert must keep a single row even when two
      // upserts arrive for the same (registration_id, chat, thread) with
      // distinct freshly-derived conversation ids.
      const first = await storage.upsertConversation(
        conversation({
          registration_id: "RT",
          conversation_id: "fresh-1" as ConversationId,
          chat_native_id: "chat-tx",
        }),
      );
      const second = await storage.upsertConversation(
        conversation({
          registration_id: "RT",
          conversation_id: "fresh-2" as ConversationId,
          chat_native_id: "chat-tx",
          last_inbound_at: 42,
        }),
      );
      // First insert keeps its own fresh id; the second collapses onto it
      // (same stable key) rather than re-keying to fresh-2.
      assert.equal(first, "fresh-1");
      assert.equal(second, "fresh-1");
      const rows = await storage.listConversations({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].conversation_id, "fresh-1");
      assert.equal(rows[0].last_inbound_at, 42);
      await storage.close();
    });
  });
});

describe("AGE-22 registration-resolved account_label (no stored column)", () => {
  function relabelRegistration(storage: unknown, registrationId: string, label: string): void {
    (storage as { db: { prepare(sql: string): { run(...p: string[]): unknown } } })
      .db.prepare("UPDATE account_registrations SET account_label = ? WHERE registration_id = ?")
      .run(label, registrationId);
  }

  it("surfaces the registration's CURRENT label on reads after a relabel, without re-keying conversation_id", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.putAccountRegistration(
        account({ registration_id: "R1", account_label: "old", bot_user_id: "bot-1" }),
      );
      await storage.upsertConversation(
        conversation({ registration_id: "R1", bot_user_id: "bot-1", conversation_id: "C1" as ConversationId }),
      );

      // Relabel the registration directly (what account-relabel will do) — NO
      // conversation upsert in between.
      relabelRegistration(storage, "R1", "new");

      const got = await storage.getConversation("C1" as ConversationId);
      assert.equal(got?.account_label, "new", "read resolves the live registration label");
      assert.equal(got?.conversation_id, "C1", "identity is unchanged by the relabel");

      const list = await storage.listConversations({});
      assert.equal(list[0]?.account_label, "new", "listConversations resolves it too");

      const found = await storage.findConversation({
        project: "project-a",
        agent: "claude" as AgentId,
        comm: "telegram" as CommId,
        registration_id: "R1",
        chat_native_id: "chat-1",
        thread_native_id: null,
      });
      assert.equal(found?.account_label, "new", "findConversation resolves it too");
      await storage.close();
    });
  });

  it("resolves account_label to \"\" for an orphan/retired registration (join miss)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      // conversation references a registration_id with no matching registration
      // (e.g. the registration was account-remove'd, or an orphan sentinel).
      await storage.upsertConversation(
        conversation({ registration_id: "orphan_CO", bot_user_id: "bot-y", conversation_id: "CO" as ConversationId }),
      );
      const got = await storage.getConversation("CO" as ConversationId);
      assert.equal(got?.account_label, "");
      assert.equal(got?.registration_id, "orphan_CO");
      await storage.close();
    });
  });

  it("no behavior path keys off account_label — bus + both bridges resolve by registration_id (source invariant)", async () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    for (const f of [
      "core-daemon/bus.ts",
      "core-daemon/bridges/claude/bridge.ts",
      "core-daemon/bridges/codex/bridge.ts",
    ]) {
      const src = await readFile(resolve(repoRoot, f), "utf8");
      assert.match(
        src,
        /candidate\.registration_id === conversation\.registration_id/,
        `${f} resolves the owning registration by registration_id`,
      );
      assert.doesNotMatch(
        src,
        /candidate\.account_label === conversation\.account_label/,
        `${f} has no account_label fallback`,
      );
    }
  });
});

describe("AGE-22 account_registrations PK rebuild (migration 007)", () => {
  function tableInfo(storage: unknown, table: string): Array<{ name: string; pk: number; notnull: number }> {
    return (storage as { db: { prepare(s: string): { all(): Array<{ name: string; pk: number; notnull: number }> } } })
      .db.prepare(`PRAGMA table_info(${table})`).all();
  }

  it("makes registration_id the sole primary key of account_registrations", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      const cols = tableInfo(storage, "account_registrations");
      assert.deepEqual(cols.filter((c) => c.pk > 0).map((c) => c.name), ["registration_id"]);
      assert.equal(cols.find((c) => c.name === "registration_id")?.notnull, 1, "registration_id is NOT NULL");
      await storage.close();
    });
  });

  it("rejects a NULL registration_id (NOT NULL enforced by the rebuild)", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      const db = (storage as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
      assert.throws(() =>
        db.prepare(`
          INSERT INTO account_registrations
            (schema_version, registration_id, project, comm, agent, account_label, bot_user_id, credentials_ref, created_at, updated_at)
          VALUES (1, NULL, 'p', 'telegram', 'claude', 'main', 'bot-null', 'ref', 1, 1)
        `).run(),
      );
      await storage.close();
    });
  });

  it("preserves BOTH uniqueness guarantees after the rebuild", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.putAccountRegistration(account({ registration_id: "r1", bot_user_id: "botU" }));
      // duplicate (comm, bot_user_id) — distinct project/agent/label so it is not an upsert
      await assert.rejects(
        storage.putAccountRegistration(
          account({ registration_id: "r2", project: "pz", agent: "codex" as AgentId, account_label: "o", bot_user_id: "botU" }),
        ),
      );
      // duplicate registration_id (the new primary key)
      await assert.rejects(
        storage.putAccountRegistration(
          account({ registration_id: "r1", project: "pz2", agent: "codex" as AgentId, account_label: "o2", bot_user_id: "botV" }),
        ),
      );
      await storage.close();
    });
  });
});

describe("AGE-22 conversations rebuild (migration 008)", () => {
  const migrationsThrough007 = [
    initialMigration,
    conversationAgentIdentityMigration,
    allowlistMigration,
    sessionOwnerProcessMigration,
    conversationBotIdentityMigration,
    registrationIdentityMigration,
    registrationPkMigration,
  ];

  it("re-keys conversations on (registration_id, chat, thread) and drops account_label", async () => {
    const dir = await makeTempDir("acb-008-");
    const db = new DatabaseSync(join(dir, "s.db"));
    try {
      const runner = new SqliteMigrationRunner(db);
      await runner.apply(migrationsThrough007);
      await runner.apply([conversationRegistrationKeyMigration]);

      const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string; pk: number; notnull: number }>;
      assert.ok(!cols.some((c) => c.name === "account_label"), "account_label column is dropped");
      assert.deepEqual(
        cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
        ["registration_id", "chat_native_id", "thread_native_id"],
      );
      assert.equal(cols.find((c) => c.name === "registration_id")?.notnull, 1, "registration_id is NOT NULL");
    } finally {
      db.close();
    }
  });

  it("preserves a null-registration_id orphan through the rebuild with a deterministic sentinel id (no history loss)", async () => {
    const dir = await makeTempDir("acb-008-orphan-");
    const db = new DatabaseSync(join(dir, "s.db"));
    try {
      const runner = new SqliteMigrationRunner(db);
      await runner.apply(migrationsThrough007);

      // A legacy orphan: null registration_id and no bot_user_id to backfill from.
      db.prepare(`
        INSERT INTO conversations
          (schema_version, project, comm, account_label, bot_user_id, registration_id,
           chat_native_id, thread_native_id, conversation_id, agent, created_at)
        VALUES (1, 'p', 'telegram', 'lbl', NULL, NULL, 'chat-1', '', 'conv-orphan', 'claude', 1)
      `).run();
      // A normal row whose registration_id backfills from (comm, bot_user_id).
      db.prepare(`
        INSERT INTO account_registrations
          (schema_version, registration_id, project, comm, agent, account_label, bot_user_id, credentials_ref, created_at, updated_at)
        VALUES (1, 'reg-ok', 'p', 'telegram', 'claude', 'main', 'bot-ok', 'ref', 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO conversations
          (schema_version, project, comm, account_label, bot_user_id, registration_id,
           chat_native_id, thread_native_id, conversation_id, agent, created_at)
        VALUES (1, 'p', 'telegram', 'main', 'bot-ok', NULL, 'chat-2', '', 'conv-ok', 'claude', 1)
      `).run();

      await runner.apply([conversationRegistrationKeyMigration]);

      const orphan = db.prepare("SELECT registration_id FROM conversations WHERE conversation_id = 'conv-orphan'").get() as { registration_id: string } | undefined;
      assert.equal(orphan?.registration_id, "orphan_conv-orphan", "orphan preserved with deterministic sentinel");
      const ok = db.prepare("SELECT registration_id FROM conversations WHERE conversation_id = 'conv-ok'").get() as { registration_id: string } | undefined;
      assert.equal(ok?.registration_id, "reg-ok", "backfilled from (comm, bot_user_id)");
      const count = db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
      assert.equal(count.n, 2, "no rows deleted");
    } finally {
      db.close();
    }
  });

  it("FAILS LOUD on a (registration_id, chat, thread) collision instead of silently dropping a row", async () => {
    const dir = await makeTempDir("acb-008-collide-");
    const db = new DatabaseSync(join(dir, "s.db"));
    try {
      const runner = new SqliteMigrationRunner(db);
      await runner.apply(migrationsThrough007);

      // Two legacy rows the OLD PK (…, account_label, …) allowed but which
      // collide on the new (registration_id, chat, thread) surrogate key. The
      // rebuild must reject (plain INSERT), NOT silently skip the second row.
      for (const [conv, label] of [["cv1", "a"], ["cv2", "b"]] as const) {
        db.prepare(`
          INSERT INTO conversations
            (schema_version, project, comm, account_label, bot_user_id, registration_id,
             chat_native_id, thread_native_id, conversation_id, agent, created_at)
          VALUES (1, 'p', 'telegram', ?, 'bot-z', 'Rdup', 'cc', '', ?, 'claude', 1)
        `).run(label, conv);
      }

      await assert.rejects(runner.apply([conversationRegistrationKeyMigration]));
    } finally {
      db.close();
    }
  });

  it("preserves conversation_id so dependent FKs (transcript_refs/sessions/queries) stay valid (foreign_key_check)", async () => {
    const dir = await makeTempDir("acb-008-fk-");
    const db = new DatabaseSync(join(dir, "s.db"));
    try {
      const runner = new SqliteMigrationRunner(db);
      await runner.apply(migrationsThrough007);

      db.prepare(`
        INSERT INTO account_registrations
          (schema_version, registration_id, project, comm, agent, account_label, bot_user_id, credentials_ref, created_at, updated_at)
        VALUES (1, 'reg-fk', 'p', 'telegram', 'claude', 'main', 'bot-fk', 'ref', 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO conversations
          (schema_version, project, comm, account_label, bot_user_id, registration_id,
           chat_native_id, thread_native_id, conversation_id, agent, created_at)
        VALUES (1, 'p', 'telegram', 'main', 'bot-fk', 'reg-fk', 'chat-fk', '', 'conv-fk', 'claude', 1)
      `).run();
      // A dependent row that FK-references the conversation by conversation_id.
      db.prepare(`
        INSERT INTO transcript_refs
          (conversation_id, message_id, direction, transcript_path, line_number, created_at)
        VALUES ('conv-fk', 'telegram:1', 'inbound', '/tmp/t.jsonl', 0, 1)
      `).run();

      await runner.apply([conversationRegistrationKeyMigration]);

      // conversation_id is preserved by the rebuild, so no dependent dangles.
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      assert.equal(violations.length, 0, "no dangling foreign-key references after the rebuild");
      const surviving = db.prepare("SELECT registration_id FROM conversations WHERE conversation_id = 'conv-fk'").get() as { registration_id: string } | undefined;
      assert.equal(surviving?.registration_id, "reg-fk");
      const ref = db.prepare("SELECT conversation_id FROM transcript_refs WHERE message_id = 'telegram:1'").get() as { conversation_id: string } | undefined;
      assert.equal(ref?.conversation_id, "conv-fk");
    } finally {
      db.close();
    }
  });
});

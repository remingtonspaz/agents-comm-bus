import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStorage } from "../../agents-comm-bus/src/storage/sqlite.js";
import type { AccountRegistration, QueryRecord, Session } from "../../agents-comm-bus-core/src/records/index.js";
import type { AccountId, AgentId, CommId, QueryId, SessionId } from "../../agents-comm-bus-core/src/types.js";

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
});

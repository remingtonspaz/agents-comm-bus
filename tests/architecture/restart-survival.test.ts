import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import type { QueryRecord, Session } from "../../packages/core-contracts/src/records/index.js";
import type { AgentId, QueryId, SessionId } from "../../packages/core-contracts/src/types.js";

function session(): Session {
  return {
    schema_version: 1,
    session_id: "session-restart" as SessionId,
    agent: "claude" as AgentId,
    project: "project-a",
    created_at: 1,
    lease_holder_connection_id: null,
    lease_acquired_at: null,
    lease_released_at: null,
    lease_owner_process_pid: null,
    lease_owner_process_label: null,
    lease_owner_process_registered_at: null,
    lease_owner_daemon_discovery_root: null,
    lease_owner_daemon_checkout_root: null,
    lease_owner_daemon_state_root: null,
    lease_owner_daemon_bin: null,
    lease_owner_daemon_authority_rank: null,
    most_recent_inbound_conversation_id: null,
    account_label_scope: null,
    status: "active",
  };
}

function pendingQuery(): QueryRecord {
  return {
    schema_version: 1,
    query_id: "query-restart" as QueryId,
    agent: "claude" as AgentId,
    session: "session-restart" as SessionId,
    kind: "freetext",
    prompt_text: "What next?",
    created_at: 2,
    ttl_seconds: 300,
    origin_chat_id: null,
    source_message_id: null,
    resolved_at: null,
    resolution: null,
    options_json: null,
  };
}

describe("storage-level restart survival", () => {
  it("loads a pending query after closing and reopening SQLite storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-restart-"));
    try {
      const dbPath = join(dir, "storage.db");

      const first = await openSqliteStorage(dbPath);
      await first.upsertSession(session());
      await first.insertQuery(pendingQuery());
      await first.close();

      const second = await openSqliteStorage(dbPath);
      const restored = await second.getOpenQueryForSession("session-restart" as SessionId);
      assert.equal(restored?.query_id, "query-restart");
      assert.equal(restored?.resolved_at, null);
      assert.equal(restored?.prompt_text, "What next?");
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

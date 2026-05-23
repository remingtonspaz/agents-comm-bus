import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStorage } from "../../agents-comm-bus/src/storage/sqlite.js";
import type { AgentId, SessionId } from "../../packages/core-contracts/src/types.js";
import type { Session } from "../../packages/core-contracts/src/records/index.js";

async function withStorage<T>(test: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-lease-"));
  try {
    return await test(join(dir, "storage.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function session(id: string, project = "project-a", agent = "claude" as AgentId): Session {
  return {
    schema_version: 1,
    session_id: id as SessionId,
    agent,
    project,
    created_at: 1,
    lease_holder_connection_id: null,
    lease_acquired_at: null,
    lease_released_at: null,
    lease_owner_process_pid: null,
    lease_owner_process_label: null,
    lease_owner_process_registered_at: null,
    most_recent_inbound_conversation_id: null,
    status: "active",
  };
}

describe("same-project Claude session lease collision", () => {
  it("refuses a second same-agent same-project live session lease", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      try {
        await storage.upsertSession(session("session-1"));
        await storage.upsertSession(session("session-2"));

        assert.equal(await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10), true);
        assert.equal(await storage.acquireSessionLease("session-2" as SessionId, "conn-2", 11), false);
      } finally {
        await storage.close();
      }
    });
  });

  it("allows the replacement lease after the first connection closes", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      try {
        await storage.upsertSession(session("session-1"));
        await storage.upsertSession(session("session-2"));

        assert.equal(await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10), true);
        await storage.releaseSessionLease("session-1" as SessionId, "conn-1", 12);
        assert.equal(await storage.acquireSessionLease("session-2" as SessionId, "conn-2", 13), true);
      } finally {
        await storage.close();
      }
    });
  });

  it("allows a concurrent Claude lease for a different project", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      try {
        await storage.upsertSession(session("session-1", "project-a"));
        await storage.upsertSession(session("session-2", "project-b"));

        assert.equal(await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10), true);
        assert.equal(await storage.acquireSessionLease("session-2" as SessionId, "conn-2", 11), true);
      } finally {
        await storage.close();
      }
    });
  });
});

describe("same-project Codex session lease collision", () => {
  it("refuses a second same-agent same-project live session lease", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      try {
        await storage.upsertSession(session("session-1", "project-a", "codex" as AgentId));
        await storage.upsertSession(session("session-2", "project-a", "codex" as AgentId));

        assert.equal(await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10), true);
        assert.equal(await storage.acquireSessionLease("session-2" as SessionId, "conn-2", 11), false);
      } finally {
        await storage.close();
      }
    });
  });

  it("allows a concurrent lease for the same project when the agent differs", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      try {
        await storage.upsertSession(session("session-1", "project-a", "claude" as AgentId));
        await storage.upsertSession(session("session-2", "project-a", "codex" as AgentId));

        assert.equal(await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10), true);
        assert.equal(await storage.acquireSessionLease("session-2" as SessionId, "conn-2", 11), true);
      } finally {
        await storage.close();
      }
    });
  });
});

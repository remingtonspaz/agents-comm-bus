import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  handleHerdrRegisterPane,
  handleHerdrReleasePane,
} from "../../core-daemon/daemon.js";
import { herdrSessionId, type HerdrIdentity } from "../../core-daemon/runtime/herdr.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { sessionFixture } from "./_session-fixture.js";
import type { AgentId, SessionId } from "../../packages/core-contracts/src/types.js";

function identity(overrides: Partial<HerdrIdentity> = {}): HerdrIdentity {
  return {
    type: "herdr",
    agent: "claude" as AgentId,
    pane_id: "w1:p9",
    socket_path: "C:\\Users\\test\\AppData\\Roaming\\herdr\\herdr.sock",
    ...overrides,
  };
}

async function withStorage<T>(
  fn: (storage: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-herdr-ipc-"));
  const storage = await openSqliteStorage(join(dir, "db.sqlite"));
  try {
    return await fn(storage);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("herdr pane IPC handlers", () => {
  it("register creates herdr_ session and calls ensureCommsForSession", async () => {
    await withStorage(async (storage) => {
      const ensureCalls: Array<{ project: string; agent: AgentId }> = [];
      const id = identity();
      const project = "D:\\repo\\herdr-pane";
      const result = await handleHerdrRegisterPane(
        { project, agent: "claude", identity: id },
        {
          storage,
          bridges: [{ agentId: "claude" as AgentId, ipcMethods: new Set() } as never],
          ensureCommsForSession: async (p, agent) => {
            ensureCalls.push({ project: p, agent });
            return { rehydrated: false };
          },
        },
      ) as { ok: boolean; session: { session_id: string } };
      assert.equal(result.ok, true);
      assert.equal(result.session.session_id, herdrSessionId(id));
      assert.deepEqual(ensureCalls, [{ project, agent: "claude" }]);
    });
  });

  it("register on existing row preserves account_label_scope", async () => {
    await withStorage(async (storage) => {
      const id = identity();
      const session_id = herdrSessionId(id) as SessionId;
      const project = "D:\\repo\\scoped";
      await storage.upsertSession(
        sessionFixture({
          session_id,
          agent: "claude" as AgentId,
          project,
          account_label_scope: "ops",
        }),
      );
      await handleHerdrRegisterPane(
        { project, agent: "claude", identity: id },
        {
          storage,
          bridges: [{ agentId: "claude" as AgentId, ipcMethods: new Set() } as never],
          ensureCommsForSession: async () => ({ rehydrated: false }),
        },
      );
      const row = await storage.getSession(session_id);
      assert.equal(row?.account_label_scope, "ops");
      assert.ok(row?.wake_identity);
    });
  });

  it("release without lease ends session; with lease clears wake target only", async () => {
    await withStorage(async (storage) => {
      const id = identity();
      const session_id = herdrSessionId(id) as SessionId;
      const project = "D:\\repo\\release";
      await handleHerdrRegisterPane(
        { project, agent: "claude", identity: id },
        {
          storage,
          bridges: [{ agentId: "claude" as AgentId, ipcMethods: new Set() } as never],
          ensureCommsForSession: async () => ({ rehydrated: false }),
        },
      );
      await handleHerdrReleasePane({ identity: id }, { storage });
      const ended = await storage.getSession(session_id);
      assert.equal(ended?.status, "ended");

      await handleHerdrRegisterPane(
        { project, agent: "claude", identity: id },
        {
          storage,
          bridges: [{ agentId: "claude" as AgentId, ipcMethods: new Set() } as never],
          ensureCommsForSession: async () => ({ rehydrated: false }),
        },
      );
      await storage.acquireSessionLease(session_id, "lease-1", Date.now());
      await handleHerdrReleasePane({ identity: id }, { storage });
      const leased = await storage.getSession(session_id);
      assert.equal(leased?.status, "active");
      assert.equal(leased?.lease_holder_connection_id, "lease-1");
      assert.equal(leased?.wake_identity, null);
    });
  });

  it("register rejects unknown agent", async () => {
    await withStorage(async (storage) => {
      await assert.rejects(
        () =>
          handleHerdrRegisterPane(
            {
              project: "D:\\repo\\x",
              agent: "pi",
              identity: identity({ agent: "pi" as AgentId }),
            },
            {
              storage,
              bridges: [{ agentId: "claude" as AgentId, ipcMethods: new Set() } as never],
              ensureCommsForSession: async () => ({ rehydrated: false }),
            },
          ),
        /unknown agent/,
      );
    });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexBridge } from "../../agents-comm-bus/src/adapters/agent/codex/bridge.js";
import { openSqliteStorage } from "../../agents-comm-bus/src/storage/sqlite.js";
import type { SessionId } from "../../agents-comm-bus-core/src/types.js";

async function withStorage<T>(test: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-codex-owner-"));
  try {
    return await test(join(dir, "storage.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Codex session owner liveness", () => {
  it("releases the session lease when the recorded owner pid is gone", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      const bridge = new CodexBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        sessionOwnerCheckIntervalMs: 5,
        isProcessAlive: () => false,
      });

      const result = await bridge.registerSession({
        session: "codex-session" as SessionId,
        project: "project-a",
        owner_process_pid: 99999,
        owner_process_label: "codex",
      });
      assert.equal(result.ok, true);

      await new Promise((resolve) => setTimeout(resolve, 40));

      const session = await storage.getSession("codex-session" as SessionId);
      assert.equal(session?.lease_holder_connection_id, null);
      assert.equal(session?.lease_owner_process_pid, null);

      await storage.close();
    });
  });
});

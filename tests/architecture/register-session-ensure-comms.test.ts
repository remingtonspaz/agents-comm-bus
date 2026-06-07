import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import type { EnsureCommsForSession } from "../../core-daemon/runtime/agent-bridge.js";
import type { AgentId, SessionId } from "../../packages/core-contracts/src/types.js";

function recordingEnsure(): {
  fn: EnsureCommsForSession;
  calls: Array<[string, AgentId]>;
} {
  const calls: Array<[string, AgentId]> = [];
  const fn: EnsureCommsForSession = async (project, agent) => {
    calls.push([project, agent]);
  };
  return { fn, calls };
}

registerTempDirCleanup();

describe("AGE-45 register-session ensureCommsForSession refresh", () => {
  it("Codex acquired lease calls ensure and preserves response shape", async () => {
    const dir = await makeTempDir("acb-age45-codex-acquire-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const { fn: ensureCommsForSession, calls } = recordingEnsure();
    const bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
      const result = await bridge.registerSession({
        session: "codex-s1" as SessionId,
        project: "project-a",
        connection_id: "codex:conn-a",
      });

      assert.equal(result.ok, true);
      assert.ok(result.capabilities);
      assert.equal(result.reason, undefined);
      assert.deepEqual(calls, [["project-a", "codex"]]);
    } finally {
      await storage.close();
    }
  });

  it("Codex held lease refresh returns ok true but still calls ensure", async () => {
    const dir = await makeTempDir("acb-age45-codex-held-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const { fn: ensureCommsForSession, calls } = recordingEnsure();
    const bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
      const session = "codex-s1" as SessionId;
      const first = await bridge.registerSession({
        session,
        project: "project-a",
        connection_id: "codex:conn-a",
      });
      assert.equal(first.ok, true);

      const held = await bridge.registerSession({
        session,
        project: "project-a",
        connection_id: "codex:conn-b",
      });

      assert.equal(held.ok, true);
      assert.equal(held.reason, "codex session lease already held; registration refreshed");
      assert.ok(held.capabilities);
      assert.deepEqual(calls, [
        ["project-a", "codex"],
        ["project-a", "codex"],
      ]);
    } finally {
      await storage.close();
    }
  });

  it("Claude acquired lease calls ensure and preserves response shape", async () => {
    const dir = await makeTempDir("acb-age45-claude-acquire-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const { fn: ensureCommsForSession, calls } = recordingEnsure();
    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
      const result = await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: "project-a",
        connection_id: "claude:conn-a",
      });

      assert.equal(result.ok, true);
      assert.equal(typeof result.wake_dir, "string");
      assert.ok(result.wake_dir!.length > 0);
      assert.equal(result.reason, undefined);
      assert.deepEqual(calls, [["project-a", "claude"]]);
    } finally {
      await storage.close();
    }
  });

  it("Claude held lease returns existing held result but still calls ensure", async () => {
    const dir = await makeTempDir("acb-age45-claude-held-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const { fn: ensureCommsForSession, calls } = recordingEnsure();
    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
      const session = "claude-s1" as SessionId;
      const first = await bridge.registerSession({
        session,
        project: "project-a",
        connection_id: "claude:conn-a",
      });
      assert.equal(first.ok, true);

      const held = await bridge.registerSession({
        session,
        project: "project-a",
        connection_id: "claude:conn-b",
      });

      assert.equal(held.ok, false);
      assert.equal(held.reason, "same-project claude session lease already held");
      assert.equal(held.wake_dir, undefined);
      assert.deepEqual(calls, [
        ["project-a", "claude"],
        ["project-a", "claude"],
      ]);
    } finally {
      await storage.close();
    }
  });
});

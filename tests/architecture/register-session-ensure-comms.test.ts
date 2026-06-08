import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type { EnsureCommsForSession } from "../../core-daemon/runtime/agent-bridge.js";
import type { AgentId, SessionId } from "../../packages/core-contracts/src/types.js";

interface EnsureCall {
  project: string;
  agent: AgentId;
  bridgeReady: boolean;
}

function recordingEnsureWithReadiness(
  bridgeReady: () => boolean,
): {
  fn: EnsureCommsForSession;
  calls: EnsureCall[];
} {
  const calls: EnsureCall[] = [];
  const fn: EnsureCommsForSession = async (project, agent) => {
    calls.push({ project, agent, bridgeReady: bridgeReady() });
  };
  return { fn, calls };
}

registerTempDirCleanup();

const PROJECT_A = normalizeProjectPath("project-a");

describe("AGE-45 register-session ensureCommsForSession refresh", () => {
  it("Codex acquired lease calls ensure after connect/trackSession and preserves response shape", async () => {
    const dir = await makeTempDir("acb-age45-codex-acquire-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const session = "codex-s1" as SessionId;
    let bridge!: CodexBridge;
    const { fn: ensureCommsForSession, calls } = recordingEnsureWithReadiness(() => {
      const tracked = (bridge as unknown as {
        sessionsByProject: Map<string, Set<SessionId>>;
      }).sessionsByProject.get(PROJECT_A)?.has(session);
      return tracked === true;
    });
    bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
      const result = await bridge.registerSession({
        session,
        project: "project-a",
        connection_id: "codex:conn-a",
      });

      assert.equal(result.ok, true);
      assert.ok(result.capabilities);
      assert.equal(result.reason, undefined);
      assert.deepEqual(calls, [{ project: PROJECT_A, agent: "codex", bridgeReady: true }]);
    } finally {
      await storage.close();
    }
  });

  it("Codex held lease refresh returns ok true but still calls ensure", async () => {
    const dir = await makeTempDir("acb-age45-codex-held-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const session = "codex-s1" as SessionId;
    let bridge!: CodexBridge;
    const { fn: ensureCommsForSession, calls } = recordingEnsureWithReadiness(() => {
      const tracked = (bridge as unknown as {
        sessionsByProject: Map<string, Set<SessionId>>;
      }).sessionsByProject.get(PROJECT_A)?.has(session);
      return tracked === true;
    });
    bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
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
      assert.equal(calls.length, 2);
      assert.equal(calls[0].bridgeReady, true, "acquired path ensures only after trackSession");
      assert.equal(calls[1].project, PROJECT_A);
      assert.equal(calls[1].agent, "codex");
    } finally {
      await storage.close();
    }
  });

  it("Claude acquired lease calls ensure after wake registration and preserves response shape", async () => {
    const dir = await makeTempDir("acb-age45-claude-acquire-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const session = "claude-s1" as SessionId;
    let bridge!: ClaudeBridge;
    const { fn: ensureCommsForSession, calls } = recordingEnsureWithReadiness(() => {
      const wake = (bridge as unknown as {
        wake: { getForSession: (id: SessionId) => unknown };
      }).wake.getForSession(session);
      return wake !== undefined;
    });
    bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
      const result = await bridge.registerSession({
        session,
        project: "project-a",
        connection_id: "claude:conn-a",
      });

      assert.equal(result.ok, true);
      assert.equal(typeof result.wake_dir, "string");
      assert.ok(result.wake_dir!.length > 0);
      assert.equal(result.reason, undefined);
      assert.deepEqual(calls, [{ project: PROJECT_A, agent: "claude", bridgeReady: true }]);
    } finally {
      await storage.close();
    }
  });

  it("Claude held lease returns existing held result but still calls ensure", async () => {
    const dir = await makeTempDir("acb-age45-claude-held-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const session = "claude-s1" as SessionId;
    let bridge!: ClaudeBridge;
    const { fn: ensureCommsForSession, calls } = recordingEnsureWithReadiness(() => {
      const wake = (bridge as unknown as {
        wake: { getForSession: (id: SessionId) => unknown };
      }).wake.getForSession(session);
      return wake !== undefined;
    });
    bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      ensureCommsForSession,
    });
    try {
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
      assert.equal(calls.length, 2);
      assert.equal(calls[0].bridgeReady, true, "acquired path ensures only after wake registration");
      assert.equal(calls[1].project, PROJECT_A);
      assert.equal(calls[1].agent, "claude");
    } finally {
      await storage.close();
    }
  });
});

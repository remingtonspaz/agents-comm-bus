import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { AgentId, AuditEvent, Session, SessionId } from "agents-comm-bus-core";
import { SCHEMA_VERSION_SESSION } from "agents-comm-bus-core";

import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import {
  DEFAULT_BOOT_RESTORE_RECENCY_MS,
  runBootScopeRestore,
} from "../../core-daemon/bootstrap/boot-scope-restore.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type { DaemonSelfIdentity, EnsureCommsForSession } from "../../core-daemon/runtime/agent-bridge.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";

registerTempDirCleanup();

const NOW = 1_700_000_000_000;
const RECENT = NOW - 60_000;
const STALE = NOW - DEFAULT_BOOT_RESTORE_RECENCY_MS - 1;
const DISCOVERY_ROOT = "C:\\Users\\me\\.agents-comm-bus";
const OTHER_DISCOVERY_ROOT = "D:\\dev\\.agents-comm-bus-discovery";

type SessionDaemonOwnerColumns = Pick<
  Session,
  | "lease_owner_daemon_discovery_root"
  | "lease_owner_daemon_checkout_root"
  | "lease_owner_daemon_state_root"
  | "lease_owner_daemon_bin"
  | "lease_owner_daemon_authority_rank"
>;

function daemonOwner(discoveryRoot: string): SessionDaemonOwnerColumns {
  return {
    lease_owner_daemon_discovery_root: discoveryRoot,
    lease_owner_daemon_checkout_root: "C:\\work\\repo",
    lease_owner_daemon_state_root: "C:\\Users\\me\\.agents-comm-bus",
    lease_owner_daemon_bin: "C:\\bin\\daemon.js",
    lease_owner_daemon_authority_rank: "production",
  };
}

function session(
  id: string,
  project: string,
  agent: AgentId,
  owner: { pid: number | null; registeredAt: number | null },
  ownerDaemon: SessionDaemonOwnerColumns | null = daemonOwner(DISCOVERY_ROOT),
): Session {
  return {
    schema_version: SCHEMA_VERSION_SESSION,
    session_id: id as SessionId,
    agent,
    project,
    created_at: 1,
    lease_holder_connection_id: null,
    lease_acquired_at: null,
    lease_released_at: null,
    lease_owner_process_pid: owner.pid,
    lease_owner_process_label: owner.pid == null ? null : agent,
    lease_owner_process_registered_at: owner.registeredAt,
    lease_owner_daemon_discovery_root: ownerDaemon?.lease_owner_daemon_discovery_root ?? null,
    lease_owner_daemon_checkout_root: ownerDaemon?.lease_owner_daemon_checkout_root ?? null,
    lease_owner_daemon_state_root: ownerDaemon?.lease_owner_daemon_state_root ?? null,
    lease_owner_daemon_bin: ownerDaemon?.lease_owner_daemon_bin ?? null,
    lease_owner_daemon_authority_rank: ownerDaemon?.lease_owner_daemon_authority_rank ?? null,
    most_recent_inbound_conversation_id: null,
    account_label_scope: null,
    status: "active",
  };
}

function fakeStorage(sessions: Session[]) {
  return {
    listSessions: async () => sessions,
  };
}

function recordingEnsure(): {
  fn: EnsureCommsForSession;
  calls: Array<{ project: string; agent: AgentId | string }>;
} {
  const calls: Array<{ project: string; agent: AgentId | string }> = [];
  return {
    calls,
    fn: async (project, agent) => {
      calls.push({ project, agent });
    },
  };
}

class FakeSocket {
  private closeHandler: (() => void) | null = null;

  once(event: "close", handler: () => void): void {
    if (event === "close") this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
  }
}

function auditRecorder(): { events: AuditEvent[]; audit: { append: (e: AuditEvent) => Promise<void> } } {
  const events: AuditEvent[] = [];
  return {
    events,
    audit: {
      append: async (event) => {
        events.push(event);
      },
    },
  };
}

function bootRestoreInput(
  overrides: Partial<Parameters<typeof runBootScopeRestore>[0]> & {
    storage: ReturnType<typeof fakeStorage>;
    ensureCommsForSession: EnsureCommsForSession;
  },
): Parameters<typeof runBootScopeRestore>[0] {
  return {
    stateRoot: "/state",
    discoveryRoot: DISCOVERY_ROOT,
    now: () => NOW,
    isPidAlive: () => true,
    pathExists: async () => false,
    ...overrides,
  };
}

describe("AGE-55 boot scope restore", () => {
  it("restores a scope whose owner pid is alive and recent", async () => {
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\proj-a");
    const { events, audit } = auditRecorder();

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", project, "claude", { pid: 42, registeredAt: RECENT }),
        ]),
        ensureCommsForSession: fn,
        audit,
        isPidAlive: (pid) => pid === 42,
      }),
    );

    assert.equal(summary.status, "completed");
    assert.equal(summary.candidates, 1);
    assert.equal(summary.restored, 1);
    assert.equal(summary.skipped_dead, 0);
    assert.equal(summary.skipped_stale, 0);
    assert.equal(summary.skipped_no_daemon_owner, 0);
    assert.equal(summary.skipped_foreign_owner, 0);
    assert.deepEqual(calls, [{ project, agent: "claude" }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "daemon_boot_restore");
    assert.equal(events[0].detail?.restored, 1);
    assert.equal(events[0].detail?.skipped_no_daemon_owner, 0);
  });

  it("does not restore a dead-owner scope", async () => {
    const { fn, calls } = recordingEnsure();

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", "D:\\work\\proj-a", "claude", { pid: 99, registeredAt: RECENT }),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: () => false,
      }),
    );

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped_dead, 1);
    assert.equal(calls.length, 0);
  });

  it("does not restore beyond the recency window", async () => {
    const { fn, calls } = recordingEnsure();

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", "D:\\work\\proj-a", "claude", { pid: 42, registeredAt: STALE }),
        ]),
        ensureCommsForSession: fn,
      }),
    );

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped_stale, 1);
    assert.equal(calls.length, 0);
  });

  it("honors the paused marker and skips all restore work", async () => {
    const { fn, calls } = recordingEnsure();
    const { events, audit } = auditRecorder();

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", "D:\\work\\proj-a", "claude", { pid: 42, registeredAt: RECENT }),
        ]),
        ensureCommsForSession: fn,
        audit,
        pathExists: async (path) => path.endsWith("/paused") || path.endsWith("\\paused"),
      }),
    );

    assert.equal(summary.status, "skipped_paused");
    assert.equal(summary.restored, 0);
    assert.equal(calls.length, 0);
    assert.equal(events[0].detail?.status, "skipped_paused");
  });

  it("de-dupes multiple sessions of the same (project, agent) to one ensure call", async () => {
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\proj-a");

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", project, "claude", { pid: 10, registeredAt: RECENT }),
          session("s2", project, "claude", { pid: 11, registeredAt: RECENT }),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: (pid) => pid === 10 || pid === 11,
      }),
    );

    assert.equal(summary.candidates, 2);
    assert.equal(summary.restored, 1);
    assert.deepEqual(calls, [{ project, agent: "claude" }]);
  });

  it("de-dupes case-variant projects to one scope (AGE-52)", async () => {
    const { fn, calls } = recordingEnsure();
    const canonical = normalizeProjectPath("D:\\work\\example-project");

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", "D:\\work\\example-project", "codex", { pid: 20, registeredAt: RECENT }),
          session("s2", "d:\\work\\example-project", "codex", { pid: 21, registeredAt: RECENT }),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: (pid) => pid === 20 || pid === 21,
      }),
    );

    assert.equal(summary.restored, 1);
    assert.deepEqual(calls, [{ project: canonical, agent: "codex" }]);
  });

  it("restores Claude scope after socket close preserves owner pid (regression)", async () => {
    const dir = await makeTempDir("acb-age55-claude-owner-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\claude-parked");
    const sessionId = "claude-s1" as SessionId;
    const connectionId = "claude:conn-1";
    const ownerPid = process.pid;
    const discoveryRoot = join(dir, "discovery");
    const daemonOwnerIdentity: DaemonSelfIdentity = {
      discoveryRoot,
      checkoutRoot: "C:\\work\\repo",
      stateRoot: dir,
      daemonBin: "daemon.js",
      authorityRank: "production",
    };

    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound: [],
      daemonOwner: daemonOwnerIdentity,
    });

    try {
      const socket = new FakeSocket();
      const result = await bridge.registerSession({
        session: sessionId,
        project,
        connection_id: connectionId,
        owner_process_pid: ownerPid,
        owner_process_label: "claude",
      }, socket);

      assert.equal(result.ok, true);

      const during = await storage.getSession(sessionId);
      assert.equal(during?.lease_holder_connection_id, connectionId);
      assert.equal(during?.lease_owner_process_pid, ownerPid);
      assert.equal(during?.lease_owner_process_label, "claude");
      assert.notEqual(during?.lease_owner_process_registered_at, null);
      assert.equal(during?.lease_owner_daemon_discovery_root, discoveryRoot);

      socket.close();

      const afterClose = await storage.getSession(sessionId);
      assert.equal(afterClose?.lease_holder_connection_id, null);
      assert.notEqual(afterClose?.lease_released_at, null);
      assert.equal(afterClose?.lease_owner_process_pid, ownerPid);
      assert.equal(afterClose?.lease_owner_process_label, "claude");
      assert.notEqual(afterClose?.lease_owner_process_registered_at, null);
      assert.equal(afterClose?.lease_owner_daemon_discovery_root, discoveryRoot);

      const summary = await runBootScopeRestore({
        stateRoot: dir,
        discoveryRoot,
        storage,
        ensureCommsForSession: fn,
        now: () => Date.now(),
        isPidAlive: (pid) => pid === ownerPid,
        pathExists: async () => false,
      });

      assert.equal(summary.restored, 1);
      assert.equal(summary.skipped_no_owner, 0);
      assert.equal(summary.skipped_no_daemon_owner, 0);
      assert.equal(summary.skipped_foreign_owner, 0);
      assert.deepEqual(calls, [{ project, agent: "claude" }]);
    } finally {
      await storage.close();
    }
  });
});

describe("AGE-58 boot scope restore daemon ownership", () => {
  it("restores when stamped discovery root matches current daemon", async () => {
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\proj-a");

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        discoveryRoot: DISCOVERY_ROOT,
        storage: fakeStorage([
          session("s1", project, "codex", { pid: 42, registeredAt: RECENT }, daemonOwner(DISCOVERY_ROOT)),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: (pid) => pid === 42,
      }),
    );

    assert.equal(summary.restored, 1);
    assert.equal(summary.skipped_no_daemon_owner, 0);
    assert.equal(summary.skipped_foreign_owner, 0);
    assert.deepEqual(calls, [{ project, agent: "codex" }]);
  });

  it("canonicalizes discovery-root separators before comparing", async () => {
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\proj-a");

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        discoveryRoot: "C:/Users/me/.agents-comm-bus",
        storage: fakeStorage([
          session(
            "s1",
            project,
            "codex",
            { pid: 42, registeredAt: RECENT },
            daemonOwner("C:\\Users\\me\\.agents-comm-bus"),
          ),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: (pid) => pid === 42,
      }),
    );

    assert.equal(summary.restored, 1);
    assert.equal(summary.skipped_no_daemon_owner, 0);
    assert.equal(summary.skipped_foreign_owner, 0);
    assert.deepEqual(calls, [{ project, agent: "codex" }]);
  });

  it("skips foreign-owner scopes with a different discovery root", async () => {
    const { fn, calls } = recordingEnsure();

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        discoveryRoot: DISCOVERY_ROOT,
        storage: fakeStorage([
          session(
            "s1",
            "D:\\work\\proj-a",
            "codex",
            { pid: 42, registeredAt: RECENT },
            daemonOwner(OTHER_DISCOVERY_ROOT),
          ),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: (pid) => pid === 42,
      }),
    );

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped_no_daemon_owner, 0);
    assert.equal(summary.skipped_foreign_owner, 1);
    assert.equal(calls.length, 0);
  });

  it("fails closed when daemon owner metadata is missing", async () => {
    const { fn, calls } = recordingEnsure();

    const summary = await runBootScopeRestore(
      bootRestoreInput({
        storage: fakeStorage([
          session("s1", "D:\\work\\proj-a", "codex", { pid: 42, registeredAt: RECENT }, null),
        ]),
        ensureCommsForSession: fn,
        isPidAlive: (pid) => pid === 42,
      }),
    );

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped_no_daemon_owner, 1);
    assert.equal(summary.skipped_foreign_owner, 0);
    assert.equal(calls.length, 0);
  });
});

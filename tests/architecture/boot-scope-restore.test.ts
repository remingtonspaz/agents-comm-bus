import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AgentId, AuditEvent, Session, SessionId } from "agents-comm-bus-core";
import { SCHEMA_VERSION_SESSION } from "agents-comm-bus-core";

import {
  DEFAULT_BOOT_RESTORE_RECENCY_MS,
  runBootScopeRestore,
} from "../../core-daemon/bootstrap/boot-scope-restore.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type { EnsureCommsForSession } from "../../core-daemon/runtime/agent-bridge.js";

const NOW = 1_700_000_000_000;
const RECENT = NOW - 60_000;
const STALE = NOW - DEFAULT_BOOT_RESTORE_RECENCY_MS - 1;

function session(
  id: string,
  project: string,
  agent: AgentId,
  owner: { pid: number | null; registeredAt: number | null },
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
    most_recent_inbound_conversation_id: null,
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

describe("AGE-55 boot scope restore", () => {
  it("restores a scope whose owner pid is alive and recent", async () => {
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\proj-a");
    const { events, audit } = auditRecorder();

    const summary = await runBootScopeRestore({
      stateRoot: "/state",
      storage: fakeStorage([
        session("s1", project, "claude", { pid: 42, registeredAt: RECENT }),
      ]),
      ensureCommsForSession: fn,
      audit,
      now: () => NOW,
      isPidAlive: (pid) => pid === 42,
      pathExists: async () => false,
    });

    assert.equal(summary.status, "completed");
    assert.equal(summary.candidates, 1);
    assert.equal(summary.restored, 1);
    assert.equal(summary.skipped_dead, 0);
    assert.equal(summary.skipped_stale, 0);
    assert.deepEqual(calls, [{ project, agent: "claude" }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "daemon_boot_restore");
    assert.equal(events[0].detail?.restored, 1);
  });

  it("does not restore a dead-owner scope", async () => {
    const { fn, calls } = recordingEnsure();

    const summary = await runBootScopeRestore({
      stateRoot: "/state",
      storage: fakeStorage([
        session("s1", "D:\\work\\proj-a", "claude", { pid: 99, registeredAt: RECENT }),
      ]),
      ensureCommsForSession: fn,
      now: () => NOW,
      isPidAlive: () => false,
      pathExists: async () => false,
    });

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped_dead, 1);
    assert.equal(calls.length, 0);
  });

  it("does not restore beyond the recency window", async () => {
    const { fn, calls } = recordingEnsure();

    const summary = await runBootScopeRestore({
      stateRoot: "/state",
      storage: fakeStorage([
        session("s1", "D:\\work\\proj-a", "claude", { pid: 42, registeredAt: STALE }),
      ]),
      ensureCommsForSession: fn,
      now: () => NOW,
      isPidAlive: () => true,
      pathExists: async () => false,
    });

    assert.equal(summary.restored, 0);
    assert.equal(summary.skipped_stale, 1);
    assert.equal(calls.length, 0);
  });

  it("honors the paused marker and skips all restore work", async () => {
    const { fn, calls } = recordingEnsure();
    const { events, audit } = auditRecorder();

    const summary = await runBootScopeRestore({
      stateRoot: "/state",
      storage: fakeStorage([
        session("s1", "D:\\work\\proj-a", "claude", { pid: 42, registeredAt: RECENT }),
      ]),
      ensureCommsForSession: fn,
      audit,
      now: () => NOW,
      isPidAlive: () => true,
      pathExists: async (path) => path.endsWith("/paused") || path.endsWith("\\paused"),
    });

    assert.equal(summary.status, "skipped_paused");
    assert.equal(summary.restored, 0);
    assert.equal(calls.length, 0);
    assert.equal(events[0].detail?.status, "skipped_paused");
  });

  it("de-dupes multiple sessions of the same (project, agent) to one ensure call", async () => {
    const { fn, calls } = recordingEnsure();
    const project = normalizeProjectPath("D:\\work\\proj-a");

    const summary = await runBootScopeRestore({
      stateRoot: "/state",
      storage: fakeStorage([
        session("s1", project, "claude", { pid: 10, registeredAt: RECENT }),
        session("s2", project, "claude", { pid: 11, registeredAt: RECENT }),
      ]),
      ensureCommsForSession: fn,
      now: () => NOW,
      isPidAlive: (pid) => pid === 10 || pid === 11,
      pathExists: async () => false,
    });

    assert.equal(summary.candidates, 2);
    assert.equal(summary.restored, 1);
    assert.deepEqual(calls, [{ project, agent: "claude" }]);
  });

  it("de-dupes case-variant projects to one scope (AGE-52)", async () => {
    const { fn, calls } = recordingEnsure();
    const canonical = normalizeProjectPath("D:\\work\\example-project");

    const summary = await runBootScopeRestore({
      stateRoot: "/state",
      storage: fakeStorage([
        session("s1", "D:\\work\\example-project", "codex", { pid: 20, registeredAt: RECENT }),
        session("s2", "d:\\work\\example-project", "codex", { pid: 21, registeredAt: RECENT }),
      ]),
      ensureCommsForSession: fn,
      now: () => NOW,
      isPidAlive: (pid) => pid === 20 || pid === 21,
      pathExists: async () => false,
    });

    assert.equal(summary.restored, 1);
    assert.deepEqual(calls, [{ project: canonical, agent: "codex" }]);
  });
});

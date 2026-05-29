import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AuditEvent, AuditStore } from "agents-comm-bus-core";
import {
  checkDaemonPidOwnership,
  runDaemonPidWatchdogTick,
  type PidFileRead,
} from "../../core-daemon/bootstrap/pid-watchdog.js";

function auditRecorder(): { audit: AuditStore; events: AuditEvent[] } {
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

describe("daemon pid watchdog", () => {
  it("retires only when daemon.pid names a different live daemon", async () => {
    const order: string[] = [];
    const { audit, events } = auditRecorder();

    const result = await runDaemonPidWatchdogTick({
      pidFile: "daemon.pid",
      port: 45_001,
      selfPid: 100,
      audit,
      readPidFile: async () => ({ status: "pid", pid: 200 }),
      isPidAlive: (pid) => pid === 200,
      stopDaemon: async () => {
        order.push("stop");
      },
      exitProcess: (code) => {
        order.push(`exit:${code}`);
      },
    });

    assert.deepEqual(result, { status: "superseded", selfPid: 100, ownerPid: 200 });
    assert.deepEqual(order, ["stop", "exit:0"]);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "daemon_superseded");
    assert.deepEqual(events[0].detail, { self_pid: 100, canonical_pid: 200 });
  });

  it("reclaims discovery when daemon.pid is missing", async () => {
    const writes: Array<{ pid?: number; port: number }> = [];
    const { audit, events } = auditRecorder();

    const result = await checkDaemonPidOwnership({
      stateRoot: "state",
      pidFile: "daemon.pid",
      port: 45_002,
      selfPid: 101,
      readPidFile: async () => ({ status: "missing" }),
      writeDiscoveryFiles: async (input) => {
        writes.push({ pid: input.pid, port: input.port });
      },
    });

    assert.deepEqual(result, { status: "reclaimed", selfPid: 101, reason: "missing" });
    assert.deepEqual(writes, [{ pid: 101, port: 45_002 }]);

    await runDaemonPidWatchdogTick({
      stateRoot: "state",
      pidFile: "daemon.pid",
      port: 45_002,
      selfPid: 101,
      audit,
      readPidFile: async () => ({ status: "missing" }),
      writeDiscoveryFiles: async () => {},
    });
    assert.equal(events[0].kind, "daemon_discovery_reclaimed");
    assert.equal(events[0].detail?.reason, "missing");
  });

  it("reclaims discovery when daemon.pid names a dead owner", async () => {
    const writes: Array<{ pid?: number; port: number }> = [];
    const { audit, events } = auditRecorder();

    const result = await runDaemonPidWatchdogTick({
      stateRoot: "state",
      pidFile: "daemon.pid",
      port: 45_003,
      selfPid: 102,
      audit,
      readPidFile: async () => ({ status: "pid", pid: 202 }),
      isPidAlive: () => false,
      writeDiscoveryFiles: async (input) => {
        writes.push({ pid: input.pid, port: input.port });
      },
      stopDaemon: async () => {
        throw new Error("must not stop when reclaiming");
      },
    });

    assert.deepEqual(result, {
      status: "reclaimed",
      selfPid: 102,
      reason: "dead_owner",
      ownerPid: 202,
    });
    assert.deepEqual(writes, [{ pid: 102, port: 45_003 }]);
    assert.equal(events[0].kind, "daemon_discovery_reclaimed");
    assert.equal(events[0].detail?.previous_pid, 202);
  });

  it("stays alive on invalid pid file content", async () => {
    const { audit, events } = auditRecorder();

    const result = await runDaemonPidWatchdogTick({
      pidFile: "daemon.pid",
      port: 45_004,
      selfPid: 103,
      audit,
      readPidFile: async () => ({ status: "invalid", raw: "not-ready" }),
      writeDiscoveryFiles: async () => {
        throw new Error("must not rewrite invalid pid races");
      },
      stopDaemon: async () => {
        throw new Error("must not retire on invalid pid");
      },
    });

    assert.equal(result.status, "stayed_alive");
    assert.equal(result.reason, "invalid_pid");
    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
    assert.equal(events[0].detail?.reason, "invalid_pid");
  });

  it("stays alive on transient read errors", async () => {
    const { audit, events } = auditRecorder();

    const result = await runDaemonPidWatchdogTick({
      pidFile: "daemon.pid",
      port: 45_005,
      selfPid: 104,
      audit,
      readPidFile: async (): Promise<PidFileRead> => ({
        status: "error",
        error: new Error("permission denied"),
      }),
      stopDaemon: async () => {
        throw new Error("must not retire on read error");
      },
    });

    assert.equal(result.status, "stayed_alive");
    assert.equal(result.reason, "read_error");
    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
    assert.equal(events[0].detail?.error, "permission denied");
  });

  it("stays alive when liveness probing fails", async () => {
    const { audit, events } = auditRecorder();

    const result = await runDaemonPidWatchdogTick({
      pidFile: "daemon.pid",
      port: 45_006,
      selfPid: 105,
      audit,
      readPidFile: async () => ({ status: "pid", pid: 205 }),
      isPidAlive: () => {
        throw new Error("probe failed");
      },
      stopDaemon: async () => {
        throw new Error("must not retire on probe failure");
      },
    });

    assert.equal(result.status, "stayed_alive");
    assert.equal(result.reason, "liveness_error");
    assert.equal(result.ownerPid, 205);
    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
  });
});

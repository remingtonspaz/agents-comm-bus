import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PiBridge } from "../../core-daemon/bridges/pi/bridge.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { managedCodexAppServerStatePath } from "../../core-daemon/bridges/codex/app-server-lifecycle.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import {
  classifySessionOwnerProcess,
  createSessionOwnerLiveness,
  DEFAULT_SESSION_OWNER_RECENCY_MS,
} from "../../core-daemon/runtime/session-owner-liveness.js";
import {
  runSessionEndSweep,
  sessionEndObservation,
  shouldSweepEndSession,
  startSessionEndSweep,
} from "../../core-daemon/runtime/session-end-sweep.js";
import {
  filterRegistrationsForSession,
} from "../../core-daemon/session-label-scope.js";
import type {
  AccountRegistration,
  AgentId,
  Session,
  SessionEndObservation,
  SessionId,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import { sessionFixture } from "./_session-fixture.js";

registerTempDirCleanup();

const DAY_MS = 24 * 60 * 60 * 1000;
const CODEX = "codex" as AgentId;
const PROJECT = "D:/work/long-running-codex";

/** Live-machine fixture: stale-but-alive Codex sessions that must never be swept. */
const LONG_RUNNING_CODEX_FIXTURE: Array<{
  session_id: string;
  pid: number;
  ageDays: number;
}> = [
  { session_id: "codex-39476", pid: 39476, ageDays: 9.4 },
  { session_id: "codex-33536", pid: 33536, ageDays: 15.2 },
  { session_id: "codex-28700", pid: 28700, ageDays: 15.2 },
  { session_id: "codex-47176", pid: 47176, ageDays: 12.3 },
];

async function withStorage<T>(test: (storage: Storage) => Promise<T>): Promise<T> {
  const dir = await makeTempDir("acb-session-end-");
  const storage = await openSqliteStorage(path.join(dir, "storage.db"));
  try {
    return await test(storage);
  } finally {
    await storage.close();
  }
}

function codexSession(
  sessionId: string,
  pid: number,
  registeredAt: number,
  leaseConn: string | null = "conn-live",
  project: string = PROJECT,
): Session {
  return sessionFixture({
    session_id: sessionId as SessionId,
    agent: CODEX,
    project,
    lease_holder_connection_id: leaseConn,
    lease_acquired_at: leaseConn ? registeredAt : null,
    lease_owner_process_pid: pid,
    lease_owner_process_label: "codex",
    lease_owner_process_registered_at: registeredAt,
    lease_owner_daemon_discovery_root: "C:/Users/me/.agents-comm-bus-discovery",
    lease_owner_daemon_state_root: "C:/Users/me/.agents-comm-bus",
  });
}

function makeFakeTimers() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void; interval: number | null }>();
  let nextId = 1;

  const runDue = () => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
        if (timer.interval != null) {
          timers.set(nextId++, {
            at: now + timer.interval,
            fn: timer.fn,
            interval: timer.interval,
          });
        }
      }
    }
  };

  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      runDue();
    },
    setTimeoutFn(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, interval: null });
      return id;
    },
    clearTimeoutFn(id: unknown) {
      timers.delete(id as number);
    },
    setIntervalFn(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, interval: ms });
      return id;
    },
    clearIntervalFn(id: unknown) {
      timers.delete(id as number);
    },
  };
}

describe("AGE-82 session end sweep", () => {
  it("ends dead owners inside the recency window", async () => {
    await withStorage(async (storage) => {
      const now = 2_000_000;
      const registeredAt = now - 1_000;
      await storage.upsertSession(
        sessionFixture({
          session_id: "dead-recent" as SessionId,
          agent: CODEX,
          project: PROJECT,
          lease_owner_process_pid: 42,
          lease_owner_process_registered_at: registeredAt,
        }),
      );

      const counts = await runSessionEndSweep({
        storage,
        now: () => now,
        isPidAlive: () => false,
      });
      assert.equal(counts.ended, 1);

      const row = await storage.getSession("dead-recent" as SessionId);
      assert.equal(row?.status, "ended");
      assert.equal(row?.lease_owner_process_pid, 42);
      assert.equal(row?.lease_holder_connection_id, null);
    });
  });

  it("does not end stale-but-alive long-running Codex sessions (live-machine fixture)", async () => {
    await withStorage(async (storage) => {
      const now = 20 * DAY_MS;
      const alive = new Set(LONG_RUNNING_CODEX_FIXTURE.map((row) => row.pid));

      for (const row of LONG_RUNNING_CODEX_FIXTURE) {
        const registeredAt = now - row.ageDays * DAY_MS;
        await storage.upsertSession(
          codexSession(
            row.session_id,
            row.pid,
            registeredAt,
            "conn-held",
            `${PROJECT}/${row.session_id}`,
          ),
        );
      }

      const counts = await runSessionEndSweep({
        storage,
        now: () => now,
        isPidAlive: (pid) => alive.has(pid),
      });
      assert.equal(counts.ended, 0);
      assert.equal(counts.kept_stale, LONG_RUNNING_CODEX_FIXTURE.length);

      for (const row of LONG_RUNNING_CODEX_FIXTURE) {
        const session = await storage.getSession(row.session_id as SessionId);
        assert.equal(session?.status, "active", row.session_id);
        assert.equal(session?.lease_owner_process_pid, row.pid);
      }
    });
  });

  it("ends no_owner sessions with no held lease", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(
        sessionFixture({
          session_id: "orphan" as SessionId,
          agent: CODEX,
          project: PROJECT,
        }),
      );

      const counts = await runSessionEndSweep({ storage });
      assert.equal(counts.ended, 1);
      assert.equal(
        (await storage.getSession("orphan" as SessionId))?.status,
        "ended",
      );
    });
  });

  it("keeps no_owner sessions while a lease is still held", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(
        sessionFixture({
          session_id: "leased-no-owner" as SessionId,
          agent: CODEX,
          project: PROJECT,
          lease_holder_connection_id: "conn-hook",
          lease_acquired_at: 1,
        }),
      );

      const counts = await runSessionEndSweep({ storage });
      assert.equal(counts.ended, 0);
      assert.equal(counts.kept_no_owner_leased, 1);
      assert.equal(
        (await storage.getSession("leased-no-owner" as SessionId))?.status,
        "active",
      );
    });
  });

  it("CAS loses safely when the row changes between read and write", async () => {
    await withStorage(async (storage) => {
      const sessionId = "reregister-race" as SessionId;
      await storage.upsertSession(
        sessionFixture({
          session_id: sessionId,
          agent: CODEX,
          project: PROJECT,
          lease_owner_process_pid: 99,
          lease_owner_process_registered_at: 100,
        }),
      );

      const original = await storage.getSession(sessionId);
      assert.ok(original);
      const observed: SessionEndObservation = sessionEndObservation(original);

      assert.equal(
        await storage.acquireSessionLease(sessionId, "conn-rereg", 500, {
          process_pid: 1001,
        }),
        true,
      );

      const ended = await storage.endSessionIfUnchanged(sessionId, observed, 200);
      assert.equal(ended, false);
      const latest = await storage.getSession(sessionId);
      assert.equal(latest?.status, "active");
      assert.equal(latest?.lease_owner_process_pid, 1001);
    });
  });

  // The race test above re-acquires with a NEW connection id, so the lease
  // condition alone rejects the CAS and the owner-stamp guard is never
  // exercised. A reconnect that keeps the same connection id but restarts the
  // owner process moves only the owner stamp — that must still lose.
  it("CAS loses when only the owner stamp changed", async () => {
    await withStorage(async (storage) => {
      const sessionId = "owner-stamp-race" as SessionId;
      await storage.upsertSession(
        sessionFixture({
          session_id: sessionId,
          agent: CODEX,
          project: PROJECT,
        }),
      );
      assert.equal(
        await storage.acquireSessionLease(sessionId, "conn-same", 100, {
          process_pid: 99,
        }),
        true,
      );

      const original = await storage.getSession(sessionId);
      assert.ok(original);
      const observed: SessionEndObservation = sessionEndObservation(original);

      // Same connection id, new owner process: only the owner stamp moves.
      assert.equal(
        await storage.acquireSessionLease(sessionId, "conn-same", 500, {
          process_pid: 1001,
        }),
        true,
      );
      const afterReacquire = await storage.getSession(sessionId);
      assert.equal(
        afterReacquire?.lease_holder_connection_id,
        observed.lease_holder_connection_id,
        "precondition: lease id unchanged, so only the owner stamp differs",
      );

      assert.equal(
        await storage.endSessionIfUnchanged(sessionId, observed, 600),
        false,
      );
      assert.equal((await storage.getSession(sessionId))?.status, "active");
    });
  });

  // Unit coverage of startSessionEndSweep proves nothing about the daemon
  // actually calling it: deleting the call site leaves the whole suite green
  // and ships the feature inert. Same gap that produced two blocking findings
  // on AGE-83.
  it("daemon wires startSessionEndSweep at boot", async () => {
    const src = await readFile(
      path.resolve(path.join(fileURLToPath(import.meta.url), "../../..", "core-daemon/daemon.ts")),
      "utf8",
    );
    assert.match(src, /sessionEndSweepHandle = startSessionEndSweep\(\{/);
    assert.match(src, /sessionEndSweepHandle\?\.stop\(\)/);
  });

  it("preserves owner and daemon stamps when ending via CAS", async () => {
    await withStorage(async (storage) => {
      const sessionId = "forensics" as SessionId;
      await storage.upsertSession(
        sessionFixture({
          session_id: sessionId,
          agent: CODEX,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_acquired_at: 10,
          lease_owner_process_pid: 555,
          lease_owner_process_label: "codex",
          lease_owner_process_registered_at: 10,
          lease_owner_daemon_discovery_root: "C:/discovery",
          lease_owner_daemon_state_root: "C:/state",
        }),
      );

      const row = await storage.getSession(sessionId);
      assert.ok(row);
      assert.equal(
        await storage.endSessionIfUnchanged(sessionId, sessionEndObservation(row), 20),
        true,
      );

      const ended = await storage.getSession(sessionId);
      assert.equal(ended?.status, "ended");
      assert.equal(ended?.lease_holder_connection_id, null);
      assert.equal(ended?.lease_released_at, 20);
      assert.equal(ended?.lease_owner_process_pid, 555);
      assert.equal(ended?.lease_owner_daemon_discovery_root, "C:/discovery");
      assert.equal(ended?.lease_owner_daemon_state_root, "C:/state");
    });
  });

  // AGE-82 B1: registration is upsert(active) THEN acquireSessionLease, and the
  // sweep can land between them. The upsert is not an observable generation
  // change, so the CAS still matches and ends the row; if acquire did not also
  // restore status, a live lease would sit on an ended row — invisible to every
  // status='active' filter and outside the partial live-lease indexes, so it
  // would evade same-scope exclusion entirely.
  it("acquiring a lease revives a row the sweep ended mid-registration", async () => {
    await withStorage(async (storage) => {
      const sessionId = "sweep-during-registration" as SessionId;

      // Registration step 1: upsert(active).
      await storage.upsertSession(
        sessionFixture({
          session_id: sessionId,
          agent: CODEX,
          project: PROJECT,
          lease_owner_process_pid: 99,
          lease_owner_process_registered_at: 100,
        }),
      );

      const row = await storage.getSession(sessionId);
      assert.ok(row);

      // Sweep interleaves here: it observed the row and ends it.
      const ended = await storage.endSessionIfUnchanged(
        sessionId,
        sessionEndObservation(row),
        200,
      );
      assert.equal(ended, true, "the sweep must win against an unchanged row");
      assert.equal((await storage.getSession(sessionId))?.status, "ended");

      // Registration step 2: acquire the lease.
      const acquired = await storage.acquireSessionLease(sessionId, "new-connection", 300, {
        process_pid: 1001,
      });
      assert.equal(acquired, true);

      const final = await storage.getSession(sessionId);
      assert.equal(
        final?.status,
        "active",
        "a live lease must never sit on an ended row",
      );
      assert.equal(final?.lease_holder_connection_id, "new-connection");
      assert.equal(final?.lease_owner_process_pid, 1001);
    });
  });

  it("reactivates an ended row on the next registration upsert", async () => {
    await withStorage(async (storage) => {
      const sessionId = "revive-me" as SessionId;
      const ended = sessionFixture({
        session_id: sessionId,
        agent: CODEX,
        project: PROJECT,
        status: "ended",
        lease_released_at: 50,
        lease_owner_process_pid: 77,
        lease_owner_process_registered_at: 10,
      });
      await storage.upsertSession(ended);

      await storage.upsertSession({
        ...ended,
        status: "active",
        lease_owner_process_pid: 88,
        lease_owner_process_registered_at: 100,
      });

      const revived = await storage.getSession(sessionId);
      assert.equal(revived?.status, "active");
      assert.equal(revived?.lease_owner_process_pid, 77);

      assert.equal(
        await storage.acquireSessionLease(sessionId, "conn-revived", 100, {
          process_pid: 88,
        }),
        true,
      );
      const leased = await storage.getSession(sessionId);
      assert.equal(leased?.lease_owner_process_pid, 88);
    });
  });

  it("keeps classifier routing unchanged — stale and dead owners remain non-live", () => {
    const registeredAt = 1_000;
    const livePid = 6_732;
    const registrations: AccountRegistration[] = [
      {
        schema_version: 1,
        project: PROJECT,
        comm: "telegram",
        agent: "claude",
        account_label: "CONSULTANT",
        bot_user_id: "bot-consultant",
        registration_id: "reg-consultant",
        credentials_ref: "file:/token.json",
        created_at: 1,
        updated_at: 1,
      },
      {
        schema_version: 1,
        project: PROJECT,
        comm: "telegram",
        agent: "claude",
        account_label: "general",
        bot_user_id: "bot-general",
        registration_id: "reg-general",
        credentials_ref: "file:/token.json",
        created_at: 1,
        updated_at: 1,
      },
    ];
    const unlabeled = sessionFixture({
      session_id: "unlabeled" as SessionId,
      agent: "claude",
      project: PROJECT,
    });
    const labeled = sessionFixture({
      session_id: "labeled" as SessionId,
      agent: "claude",
      project: PROJECT,
      account_label_scope: JSON.stringify({ telegram: "CONSULTANT" }),
      lease_owner_process_pid: livePid,
      lease_owner_process_registered_at: registeredAt,
    });

    const staleAlive = createSessionOwnerLiveness({
      now: () => registeredAt + DEFAULT_SESSION_OWNER_RECENCY_MS + 1,
      isPidAlive: () => true,
    });
    assert.equal(
      classifySessionOwnerProcess(labeled, {
        now: () => registeredAt + DEFAULT_SESSION_OWNER_RECENCY_MS + 1,
        isPidAlive: () => true,
      }),
      "stale",
    );
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, labeled],
        staleAlive,
      ).map((row) => row.account_label),
      ["CONSULTANT", "general"],
    );

    const deadRecent = createSessionOwnerLiveness({
      now: () => registeredAt + 1,
      isPidAlive: () => false,
    });
    assert.equal(
      classifySessionOwnerProcess(labeled, {
        now: () => registeredAt + 1,
        isPidAlive: () => false,
      }),
      "dead",
    );
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, labeled],
        deadRecent,
      ).map((row) => row.account_label),
      ["CONSULTANT", "general"],
    );
  });

  it("periodic sweep is single-flight", async () => {
    const clock = makeFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let sweepCalls = 0;

    // The first sweep is gated on an explicit release rather than a fake timer,
    // so a periodic tick provably fires *while it is still in flight*. The
    // previous version advanced past the timeout that installs the interval but
    // never reached a tick during the pending sweep, so deleting the
    // `if (sweepInFlight) return;` guard left it green.
    let releaseFirst: (() => void) | undefined;
    const firstSweepGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const storage: Storage = {
      async listSessions() {
        sweepCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (sweepCalls === 1) await firstSweepGate;
        inFlight -= 1;
        return [];
      },
    } as unknown as Storage;

    const sweep = startSessionEndSweep({
      storage,
      intervalMs: 50,
      runOnStart: true,
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
    });

    clock.advance(0);
    await Promise.resolve();
    assert.equal(sweepCalls, 1, "boot sweep should have started");

    // t=50 only fires the timeout that INSTALLS the interval; the interval's
    // first tick is at t=100. Both must land while the boot sweep is pending,
    // otherwise nothing ever overlaps and the guard is never exercised.
    clock.advance(50);
    await Promise.resolve();
    clock.advance(50);
    await Promise.resolve();
    assert.equal(sweepCalls, 1, "a tick during an in-flight sweep must not start a second pass");
    assert.equal(maxInFlight, 1);

    releaseFirst?.();
    await firstSweepGate;
    // Let the sweep's finally-block clear the in-flight flag and run any pending replay.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      sweepCalls,
      2,
      "overlapped tick during in-flight must replay after the first sweep completes",
    );
    assert.equal(maxInFlight, 1);

    // A later tick, with nothing in flight and no pending replay, must start another pass.
    clock.advance(50);
    await Promise.resolve();
    assert.equal(sweepCalls, 3, "a tick after replay finished must run");
    assert.equal(maxInFlight, 1);
    sweep.stop();
  });
});

describe("AGE-82 endSessionIfUnchanged wiring", () => {
  it("runSessionEndSweep invokes storage.endSessionIfUnchanged for eligible rows", async () => {
    const calls: Array<{ session: SessionId; observed: SessionEndObservation }> = [];
    const sessionId = "sweep-target" as SessionId;
    const row = sessionFixture({
      session_id: sessionId,
      agent: CODEX,
      project: PROJECT,
    });

    const storage = {
      async listSessions() {
        return [row];
      },
      async endSessionIfUnchanged(
        session: SessionId,
        observed: SessionEndObservation,
        _at: number,
      ) {
        calls.push({ session, observed });
        return true;
      },
    } as unknown as Storage;

    await runSessionEndSweep({ storage });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.session, sessionId);
    assert.deepEqual(calls[0]?.observed, sessionEndObservation(row));
  });

  it("Pi unregisterSession invokes endSessionIfUnchanged", async () => {
    const calls: SessionId[] = [];
    const sessionId = "pi-session" as SessionId;
    const row = sessionFixture({
      session_id: sessionId,
      agent: "pi",
      project: normalizeProjectPath(PROJECT),
      lease_holder_connection_id: "pi:runtime",
      lease_acquired_at: 1,
      lease_owner_process_pid: 4242,
      lease_owner_process_registered_at: 1,
    });

    const storage = {
      async getSession(session: SessionId) {
        return session === sessionId ? row : null;
      },
      async endSessionIfUnchanged(session: SessionId) {
        calls.push(session);
        return true;
      },
    } as unknown as Storage;

    const bridge = new PiBridge({
      storage,
      bus: new MessageBus({
        project: PROJECT,
        storage: { listAccountRegistrations: async () => [] } as never,
        transcripts: { append: async () => {} } as never,
        audit: { append: async () => {} } as never,
        blobs: {} as never,
        comms: [],
      }),
      pendingInbound: [],
    });

    await bridge.unregisterSession({
      session: sessionId,
      project: normalizeProjectPath(PROJECT),
      connection_id: "pi:runtime",
    });
    assert.deepEqual(calls, [sessionId]);
  });

  // AGE-82 B2: storage.releaseSessionLease NULLs every owner/daemon stamp, so a
  // managed release followed by cleanup would end a scrubbed row and destroy the
  // forensics the sweep is required to preserve. The cleanup test below drives
  // the private method on an unreleased fixture, which cannot observe this — so
  // pin the branch itself. This is a source-level assertion, not a lifecycle
  // test; the real release→cleanup sequence is verified in cross-review.
  it("Codex managed release preserves owner stamps for the later end", async () => {
    const src = await readFile(
      path.resolve(
        path.join(fileURLToPath(import.meta.url), "../../..", "core-daemon/bridges/codex/bridge.ts"),
      ),
      "utf8",
    );
    const release = src.slice(src.indexOf("private async releaseSessionLease"));
    const body = release.slice(0, release.indexOf("\n  private "));
    assert.match(
      body,
      /if \(input\.manageAppServerLifecycle\)[\s\S]*?releaseSessionConnectionLeasePreservingOwner/,
      "the managed branch must preserve owner stamps until the row is ended",
    );
  });

  it("Codex managed lifecycle cleanup invokes endSessionIfUnchanged", async () => {
    const home = await makeTempDir("codex-managed-home-");
    const previousHome = process.env.USERPROFILE;
    const previousHomedir = os.homedir;
    process.env.USERPROFILE = home;
    Object.defineProperty(os, "homedir", {
      configurable: true,
      value: () => home,
    });

    try {
      await withStorage(async (storage) => {
        const sessionId = "codex-managed" as SessionId;
        await storage.upsertSession(
          sessionFixture({
            session_id: sessionId,
            agent: CODEX,
            project: PROJECT,
            lease_owner_process_pid: 9001,
            lease_owner_process_registered_at: 1,
          }),
        );

        const statePath = managedCodexAppServerStatePath(sessionId);
        await mkdir(path.dirname(statePath), { recursive: true });
        await writeFile(
          statePath,
          JSON.stringify({
            sessionId,
            appServerUrl: "ws://127.0.0.1:4999",
            appServerPid: 1,
            appServerTerminalPid: 2,
            wrapperPath: "D:/tmp/wrapper.ps1",
          }),
          "utf8",
        );

        const calls: SessionId[] = [];
        const originalEnd = storage.endSessionIfUnchanged.bind(storage);
        storage.endSessionIfUnchanged = async (session, observed, at) => {
          calls.push(session);
          return originalEnd(session, observed, at);
        };

        const bridge = new CodexBridge({
          storage,
          bus: new MessageBus({
            project: PROJECT,
            storage: { listAccountRegistrations: async () => [] } as never,
            transcripts: { append: async () => {} } as never,
            audit: { append: async () => {} } as never,
            blobs: {} as never,
            comms: [],
          }),
          pendingInbound: [],
        });

        await (
          bridge as unknown as {
            cleanupManagedAppServerIfLeaseIsIdle: (s: SessionId) => Promise<void>;
          }
        ).cleanupManagedAppServerIfLeaseIsIdle(sessionId);

        assert.deepEqual(calls, [sessionId]);
        assert.equal((await storage.getSession(sessionId))?.status, "ended");
        assert.equal(
          (await storage.getSession(sessionId))?.lease_owner_process_pid,
          9001,
        );
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousHome;
      }
      Object.defineProperty(os, "homedir", {
        configurable: true,
        value: previousHomedir,
      });
    }
  });
});

describe("AGE-82 shouldSweepEndSession", () => {
  it("never ends on age alone when the owner pid is still alive", () => {
    const now = 30 * DAY_MS;
    const session = codexSession("codex-old", 123, now - 29 * DAY_MS);
    assert.equal(
      shouldSweepEndSession(session, {
        now: () => now,
        isPidAlive: () => true,
      }),
      false,
    );
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectIpc } from "../../core-daemon/ipc/client.js";
import { startIpcServer } from "../../core-daemon/ipc/server.js";
import {
  discoveryFilesMatchSelf,
  IDLE_NO_OWNED_RESOURCES_REASON,
  removeDiscoveryFilesIfOwned,
  resetDaemonRetirementGuardForTests,
  retireDaemon,
} from "../../core-daemon/bootstrap/daemon-retirement.js";
import {
  CommLeaseArbiter,
  commLeasePath,
  type SelfIdentity,
} from "../../core-daemon/runtime/comm-lease.js";
import {
  DEFAULT_IDLE_REAPER_GRACE_MS,
  sampleStructuralEligibility,
  shouldIdleReaperRetire,
  startIdleReaper,
} from "../../core-daemon/runtime/daemon-idle-reaper.js";
import type { RetirementBlockerSnapshot } from "../../core-daemon/runtime/agent-bridge.js";
import { ClaudeOpenQueryTracker } from "../../core-daemon/bridges/claude/open-query-tracker.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { IPC_PROTOCOL_VERSION } from "../../core-daemon/config.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  AuditEvent,
  AuditStore,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  Conversation,
  ConversationId,
  FailureClassification,
  Message,
  MessageId,
  OutboundPayload,
  QueryId,
  ResolvedDecision,
  SendResult,
  Session,
  SessionId,
} from "../../packages/core-contracts/src/index.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const BOT = "bot-1";
const CONV = "conversation-1" as ConversationId;
const SESSION = "session-1" as SessionId;

function selfIdentity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    pid: 1000,
    stateRoot: "/state/a",
    checkoutRoot: "/checkout/a",
    daemonBin: null,
    daemonVersion: "0.0.0",
    authorityRank: "main-dev",
    ...over,
  };
}

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

async function assertConnectionCountEventually(
  server: { getLiveConnectionCount(): number },
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (server.getLiveConnectionCount() === expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(server.getLiveConnectionCount(), expected);
}

function makeFakeTimers() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void; interval?: number }>();
  let nextId = 1;
  return {
    now: () => now,
    advance(ms: number) {
      const target = now + ms;
      while (now < target) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) {
          now = target;
          break;
        }
        for (const [id, timer] of due) {
          if (timer.at > now) now = timer.at;
          timer.fn();
          if (timer.interval != null) {
            timer.at = now + timer.interval;
          } else {
            timers.delete(id);
          }
        }
      }
    },
    setIntervalFn(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, interval: ms });
      return id;
    },
    clearIntervalFn(id: unknown) {
      timers.delete(id as number);
    },
    setTimeoutFn(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeoutFn(id: unknown) {
      timers.delete(id as number);
    },
  };
}

function baseSampleInput(over: Partial<Parameters<typeof sampleStructuralEligibility>[0]> = {}) {
  const now = 100_000;
  return {
    now,
    lastIpcServedAt: 0,
    graceMs: DEFAULT_IDLE_REAPER_GRACE_MS,
    heldLeaseCount: () => 0,
    liveIpcConnectionCount: () => 0,
    pendingInboundLength: () => 0,
    inFlightAdapterCount: () => 0,
    bridgeBlockers: () => ({} as Record<string, RetirementBlockerSnapshot | null>),
    ...over,
  };
}

function account(): AccountRegistration {
  return {
    schema_version: 1,
    project: "project-a",
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: `reg-${BOT}`,
    credentials_ref: "keyring://telegram/main",
    created_at: 1,
    updated_at: 1,
  };
}

function session(): Session {
  return {
    schema_version: 1,
    session_id: SESSION,
    agent: CLAUDE,
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

function conversation(): Conversation {
  return {
    schema_version: 1,
    project: "project-a",
    comm: TELEGRAM,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: `reg-${BOT}`,
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: CONV,
    agent: CLAUDE,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_id: null,
    created_at: 1,
  };
}

class RecordingAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly accountId = BOT as AccountId;
  readonly allowedSenderIds: readonly string[] = [];
  readonly sent: Array<{ target: ChatRef; payload: OutboundPayload }> = [];
  private seq = 900;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onInbound(_handler: (msg: Message) => Promise<void>): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}
  async send(target: ChatRef, payload: OutboundPayload): Promise<SendResult> {
    this.sent.push({ target, payload });
    this.seq += 1;
    return { platform_message_id: `telegram:${this.seq}` as MessageId, sent_at: 11_000 };
  }
  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure(_error: unknown): FailureClassification {
    return "transient";
  }
}

class FailingSendAdapter extends RecordingAdapter {
  override async send(): Promise<SendResult> {
    throw new Error("send failed");
  }
}

registerTempDirCleanup();

describe("AGE-36 idle reaper eligibility", () => {
  it("is structurally eligible when runtime-local blockers are clear", () => {
    const result = sampleStructuralEligibility(baseSampleInput());
    assert.equal(result.structurallyEligible, true);
    assert.deepEqual(result.reasons, []);
  });

  it("reports ipc_quiet_for_grace separately from structural blockers", () => {
    const quiet = sampleStructuralEligibility(
      baseSampleInput({ now: 200_000, lastIpcServedAt: 0, graceMs: 90_000 }),
    );
    assert.equal(quiet.structurallyEligible, true);
    assert.equal(quiet.blockers.ipc_quiet_for_grace, true);

    const active = sampleStructuralEligibility(
      baseSampleInput({ now: 50_000, lastIpcServedAt: 49_500, graceMs: 90_000 }),
    );
    assert.equal(active.structurallyEligible, true);
    assert.equal(active.blockers.ipc_quiet_for_grace, false);
  });

  it("blocks on held leases, live IPC, pending inbound, in-flight adapters, bridge blockers", () => {
    for (const [field, reason] of [
      [() => ({ heldLeaseCount: () => 1 }), "held_leases"],
      [() => ({ liveIpcConnectionCount: () => 1 }), "live_ipc_connections"],
      [() => ({ pendingInboundLength: () => 1 }), "pending_inbound"],
      [() => ({ inFlightAdapterCount: () => 1 }), "in_flight_adapters"],
      [
        () => ({ bridgeBlockers: () => ({ claude: { open_queries: 1 } }) }),
        "bridge_blockers",
      ],
    ] as const) {
      const result = sampleStructuralEligibility(baseSampleInput(field()));
      assert.equal(result.structurallyEligible, false);
      assert.ok(result.reasons.includes(reason));
    }
  });
});

describe("AGE-36 idle reaper grace semantics", () => {
  it("retires after one grace when structural blockers clear and IPC is already quiet", () => {
    const grace = 100;
    const lastIpc = 0;
    const structuralSince = 50;
    assert.equal(
      shouldIdleReaperRetire({
        now: 149,
        graceMs: grace,
        structuralEligibleSince: structuralSince,
        lastIpcServedAt: lastIpc,
        structurallyEligible: true,
      }),
      false,
    );
    assert.equal(
      shouldIdleReaperRetire({
        now: 150,
        graceMs: grace,
        structuralEligibleSince: structuralSince,
        lastIpcServedAt: lastIpc,
        structurallyEligible: true,
      }),
      true,
    );
  });

  it("does not impose ~2x grace when IPC went quiet long before structural clearance", () => {
    const clock = makeFakeTimers();
    const grace = 100;
    let lastIpc = 0;
    let heldLeases = 1;
    let retireCount = 0;

    const reaper = startIdleReaper({
      graceMs: grace,
      intervalMs: 10,
      initialDelayMs: 0,
      now: clock.now,
      lastIpcServedAt: () => lastIpc,
      heldLeaseCount: () => heldLeases,
      liveIpcConnectionCount: () => 0,
      pendingInboundLength: () => 0,
      inFlightAdapterCount: () => 0,
      bridgeBlockers: () => ({}),
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      retire: () => {
        retireCount += 1;
      },
    });

    clock.advance(0);
    clock.advance(49);
    heldLeases = 0;
    clock.advance(1);
    clock.advance(99);
    assert.equal(retireCount, 0, "must not retire before one grace from structural clearance");
    clock.advance(1);
    assert.equal(retireCount, 1, "retire at structuralSince+grace, not ~2x grace from last IPC");
    reaper.stop();
  });

  it("resets structuralEligibleSince when a blocker reappears", () => {
    const clock = makeFakeTimers();
    let heldLeases = 0;
    let retireCount = 0;
    const reaper = startIdleReaper({
      graceMs: 100,
      intervalMs: 10,
      initialDelayMs: 0,
      now: clock.now,
      lastIpcServedAt: () => 0,
      heldLeaseCount: () => heldLeases,
      liveIpcConnectionCount: () => 0,
      pendingInboundLength: () => 0,
      inFlightAdapterCount: () => 0,
      bridgeBlockers: () => ({}),
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      retire: () => {
        retireCount += 1;
      },
    });

    clock.advance(0);
    clock.advance(60);
    heldLeases = 1;
    clock.advance(10);
    assert.equal(retireCount, 0);
    heldLeases = 0;
    clock.advance(110);
    assert.equal(retireCount, 1);
    reaper.stop();
  });
});

describe("AGE-36 IPC live connection count", () => {
  it("counts connections through handshake and decrements on close", async () => {
    const server = await startIpcServer({ protocolVersion: IPC_PROTOCOL_VERSION });
    try {
      assert.equal(server.getLiveConnectionCount(), 0);
      const client = await connectIpc({
        port: server.port,
        protocolVersion: IPC_PROTOCOL_VERSION,
        clientVersion: "test",
      });
      assert.equal(server.getLiveConnectionCount(), 1);
      client.close();
      await assertConnectionCountEventually(server, 0);
    } finally {
      await server.close();
    }
  });
});

describe("AGE-36 comm lease inventory", () => {
  async function tempHome(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "acb-age36-lease-"));
  }

  it("tracks acquire, renew-loss, and release transitions", async () => {
    const home = await tempHome();
    const now = () => 1_000;
    const alive = new Set<number>([100, 200]);
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 100 }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now,
    });

    assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
    assert.equal(arbiter.heldLeaseCount(), 1);

    const rival = new CommLeaseArbiter({
      self: selfIdentity({ pid: 200, authorityRank: "main-dev" }),
      lastIpcServedAt: () => 50_000,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 100_000,
    });
    assert.equal((await rival.tryAcquire("telegram", "bot-1")).ok, true);

    const renew = await arbiter.renew("telegram", "bot-1");
    assert.equal(renew.ok, false);
    assert.equal(arbiter.heldLeaseCount(), 0);

    await arbiter.release("telegram", "bot-1");
    assert.equal(arbiter.heldLeaseCount(), 0);
    await rival.release("telegram", "bot-1");
    assert.equal(rival.heldLeaseCount(), 0);
  });

  it("clears local inventory on release even when the on-disk lease is gone or replaced", async () => {
    const home = await tempHome();
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 100 }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 1_000,
    });
    assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
    assert.equal(arbiter.heldLeaseCount(), 1);

    const leasePath = commLeasePath("telegram", "bot-1", home);
    await rm(leasePath, { force: true });
    await arbiter.release("telegram", "bot-1");
    assert.equal(arbiter.heldLeaseCount(), 0);

    assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
    assert.equal(arbiter.heldLeaseCount(), 1);

    const rival = new CommLeaseArbiter({
      self: selfIdentity({ pid: 200, authorityRank: "main-dev" }),
      lastIpcServedAt: () => 100_000,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 2_000,
    });
    assert.equal((await rival.tryAcquire("telegram", "bot-1")).ok, true);
    await arbiter.release("telegram", "bot-1");
    assert.equal(arbiter.heldLeaseCount(), 0);
  });

  it("clears local inventory when renew observes loss through a contended guard", async () => {
    const home = await tempHome();
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 100 }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => pid === 999,
      now: () => 1_000,
    });
    assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
    assert.equal(arbiter.heldLeaseCount(), 1);

    const leasePath = commLeasePath("telegram", "bot-1", home);
    const replacement = JSON.parse(await readFile(leasePath, "utf8")) as { pid: number };
    replacement.pid = 200;
    await writeFile(leasePath, `${JSON.stringify(replacement)}\n`, "utf8");
    await writeFile(`${leasePath}.guard`, "999:1000\n", "utf8");

    const renew = await arbiter.renew("telegram", "bot-1");
    assert.deepEqual(renew, { ok: false, reason: "lost", holder: replacement });
    assert.equal(arbiter.heldLeaseCount(), 0);
  });
});

describe("AGE-36 discovery ownership cleanup", () => {
  it("matches only when on-disk pid and port both equal self", () => {
    assert.equal(
      discoveryFilesMatchSelf({ selfPid: 10, selfPort: 45_001, onDiskPid: 10, onDiskPort: 45_001 }),
      true,
    );
    assert.equal(
      discoveryFilesMatchSelf({ selfPid: 10, selfPort: 45_001, onDiskPid: 11, onDiskPort: 45_001 }),
      false,
    );
    assert.equal(
      discoveryFilesMatchSelf({ selfPid: 10, selfPort: 45_001, onDiskPid: 10, onDiskPort: 45_002 }),
      false,
    );
  });

  it("removes discovery files only when pid and port match self", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acb-age36-disc-"));
    const pidFile = path.join(root, "daemon.pid");
    const portFile = path.join(root, "port");
    await writeFile(pidFile, "42\n", "utf8");
    await writeFile(portFile, "45010\n", "utf8");

    assert.equal(
      await removeDiscoveryFilesIfOwned({
        discoveryRoot: root,
        selfPid: 42,
        selfPort: 45_010,
        readPidFile: async () => 42,
        readPortFile: async () => 45_010,
      }),
      true,
    );
    await assert.rejects(() => readFile(pidFile, "utf8"));

    await writeFile(pidFile, "42\n", "utf8");
    await writeFile(portFile, "45011\n", "utf8");
    assert.equal(
      await removeDiscoveryFilesIfOwned({
        discoveryRoot: root,
        selfPid: 42,
        selfPort: 45_010,
      }),
      false,
    );
    assert.equal((await readFile(pidFile, "utf8")).trim(), "42");
    assert.equal((await readFile(portFile, "utf8")).trim(), "45011");

    await writeFile(pidFile, "99\n", "utf8");
    await writeFile(portFile, "45010\n", "utf8");
    assert.equal(
      await removeDiscoveryFilesIfOwned({
        discoveryRoot: root,
        selfPid: 42,
        selfPort: 45_010,
      }),
      false,
    );
    assert.equal((await readFile(pidFile, "utf8")).trim(), "99");
    assert.equal((await readFile(portFile, "utf8")).trim(), "45010");
    await rm(root, { recursive: true, force: true });
  });
});

describe("AGE-36 daemon retirement", () => {
  it("audits idle_no_owned_resources and exits once", async () => {
    resetDaemonRetirementGuardForTests();
    const { audit, events } = auditRecorder();
    const order: string[] = [];

    const ok = await retireDaemon({
      reason: IDLE_NO_OWNED_RESOURCES_REASON,
      selfPid: 77,
      port: 45_099,
      audit,
      stopTimers: () => order.push("stop-timers"),
      stopBus: async () => order.push("stop-bus"),
      closeIpc: async () => order.push("close-ipc"),
      removeDiscoveryFiles: async () => {
        order.push("remove-discovery");
        return true;
      },
      exitProcess: (code) => order.push(`exit:${code}`),
    });

    assert.equal(ok, true);
    assert.deepEqual(order, ["stop-timers", "stop-bus", "close-ipc", "remove-discovery", "exit:0"]);
    assert.equal(events[0].kind, "daemon_retired");
  });

  it("still exits when discovery cleanup throws", async () => {
    resetDaemonRetirementGuardForTests();
    let exited = false;
    const ok = await retireDaemon({
      reason: IDLE_NO_OWNED_RESOURCES_REASON,
      port: 1,
      removeDiscoveryFiles: async () => {
        throw new Error("discovery rm failed");
      },
      exitProcess: () => {
        exited = true;
      },
    });
    assert.equal(ok, true);
    assert.equal(exited, true);
  });

  it("continues cleanup and exits when stopping timers throws", async () => {
    resetDaemonRetirementGuardForTests();
    const order: string[] = [];
    const ok = await retireDaemon({
      reason: IDLE_NO_OWNED_RESOURCES_REASON,
      port: 1,
      stopTimers: () => {
        order.push("stop-timers");
        throw new Error("timer stop failed");
      },
      stopBus: async () => {
        order.push("stop-bus");
      },
      closeIpc: async () => {
        order.push("close-ipc");
      },
      removeDiscoveryFiles: async () => {
        order.push("remove-discovery");
        return true;
      },
      exitProcess: () => {
        order.push("exit");
      },
    });
    assert.equal(ok, true);
    assert.deepEqual(order, ["stop-timers", "stop-bus", "close-ipc", "remove-discovery", "exit"]);
  });

  it("is idempotent when retirement races", async () => {
    resetDaemonRetirementGuardForTests();
    let exits = 0;
    const first = await retireDaemon({
      reason: IDLE_NO_OWNED_RESOURCES_REASON,
      port: 1,
      exitProcess: () => {
        exits += 1;
      },
    });
    const second = await retireDaemon({
      reason: IDLE_NO_OWNED_RESOURCES_REASON,
      port: 1,
      exitProcess: () => {
        exits += 1;
      },
    });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(exits, 1);
  });
});

describe("AGE-36 Claude open-query blockers", () => {
  it("tracks via the public openQuery flow, resolve sink, supersede, send-failure, and TTL", async () => {
    const dir = await makeTempDir("acb-age36-claude-");
    const clock = makeFakeTimers();
    const storage = await openSqliteStorage(path.join(dir, "storage.db"));
    await storage.putAccountRegistration(account());
    await storage.upsertSession(session());
    await storage.upsertConversation(conversation());
    await storage.setSessionMostRecentInbound(SESSION, CONV);

    const adapter = new RecordingAdapter();
    const bus = new MessageBus({
      project: "project-a",
      storage,
      transcripts: { append: async () => {} } as never,
      audit: { append: async () => {} } as never,
      blobs: {} as never,
      comms: [adapter],
    });
    const bridge = new ClaudeBridge({
      storage,
      bus,
      pendingInbound: [],
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    bridge.attach([adapter]);
    (bridge as unknown as { wake: { register(input: unknown): void } }).wake.register({
      session: SESSION,
      project: "project-a",
      wakeDir: path.join(dir, "wake"),
    });

    assert.equal(bridge.getRetirementBlockers(), null);

    const first = await bridge.openQuery({
      session: SESSION,
      tool_name: "Bash",
      prompt_text: "Allow?",
      kind: "approval",
      ttl_seconds: 60,
    });
    assert.deepEqual(bridge.getRetirementBlockers(), { open_queries: 1 });

    const superseded = await bridge.openQuery({
      session: SESSION,
      tool_name: "Bash",
      prompt_text: "Supersede",
      kind: "approval",
      supersede: true,
      ttl_seconds: 60,
    });
    assert.deepEqual(bridge.getRetirementBlockers(), { open_queries: 1 });

    await bridge.openQuery({
      session: SESSION,
      tool_name: "Bash",
      prompt_text: "TTL",
      kind: "approval",
      supersede: false,
      ttl_seconds: 0.05,
    });
    assert.deepEqual(bridge.getRetirementBlockers(), { open_queries: 2 });
    clock.advance(50);
    assert.deepEqual(bridge.getRetirementBlockers(), { open_queries: 1 });

    await bus.resolveQueryFromCallback({
      queryId: superseded.query_id,
      value: "y",
      fromId: "user-1",
      chat: {
        comm: TELEGRAM,
        account: BOT as AccountId,
        chat_native_id: "chat-1",
      },
    });
    assert.equal(bridge.getRetirementBlockers(), null);

    const failAdapter = new FailingSendAdapter();
    const failBus = new MessageBus({
      project: "project-a",
      storage,
      transcripts: { append: async () => {} } as never,
      audit: { append: async () => {} } as never,
      blobs: {} as never,
      comms: [failAdapter],
    });
    const failBridge = new ClaudeBridge({
      storage,
      bus: failBus,
      pendingInbound: [],
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    failBridge.attach([failAdapter]);
    await assert.rejects(
      () =>
        failBridge.openQuery({
          session: SESSION,
          tool_name: "Bash",
          prompt_text: "fail",
          kind: "approval",
          ttl_seconds: 60,
        }),
      /send failed/,
    );
    assert.equal(failBridge.getRetirementBlockers(), null);

    await storage.close();
  });

  it("exercises ClaudeOpenQueryTracker independently", () => {
    const clock = makeFakeTimers();
    const tracker = new ClaudeOpenQueryTracker({
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });
    tracker.trackOpenQuery("sess-1" as SessionId, "q-1" as QueryId, 0.05);
    assert.deepEqual(tracker.getRetirementBlockers(), { open_queries: 1 });
    clock.advance(50);
    assert.equal(tracker.getRetirementBlockers(), null);
  });
});

describe("AGE-36 Codex managed lifecycle blockers", () => {
  it("reports managed lifecycle and pending cleanup via generic reason keys", async () => {
    const { CodexBridge } = await import("../../core-daemon/bridges/codex/bridge.js");
    const clock = makeFakeTimers();
    const bridge = new CodexBridge({
      storage: { getSession: async () => null } as never,
      bus: new MessageBus({
        project: "p",
        storage: { listAccountRegistrations: async () => [] } as never,
        transcripts: { append: async () => {} } as never,
        audit: { append: async () => {} } as never,
        blobs: {} as never,
        comms: [],
      }),
      pendingInbound: [],
      appServerCleanupDelayMs: 50,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    assert.equal(bridge.getRetirementBlockers(), null);

    const lease = {
      session: "sess-codex" as SessionId,
      project: "p",
      connectionId: "conn-1",
      manageAppServerLifecycle: true,
      control: { close() {}, onClose() {}, async send() {} },
      released: false,
    };
    (bridge as unknown as { activeLeases: Map<string, unknown> }).activeLeases.set(
      "sess-codex",
      lease,
    );
    assert.deepEqual(bridge.getRetirementBlockers(), { managed_lifecycle: 1 });

    lease.released = true;
    (bridge as unknown as { activeLeases: Map<string, unknown> }).activeLeases.delete("sess-codex");
    (bridge as unknown as { scheduleManagedAppServerCleanup: (s: SessionId) => void })
      .scheduleManagedAppServerCleanup("sess-codex");
    assert.deepEqual(bridge.getRetirementBlockers(), { pending_managed_cleanup: 1 });
    (bridge as unknown as { cleanupManagedAppServerIfLeaseIsIdle: (s: SessionId) => Promise<void> })
      .cleanupManagedAppServerIfLeaseIsIdle = async () => {};
    clock.advance(50);
    await Promise.resolve();
    assert.equal(bridge.getRetirementBlockers(), null);
  });
});

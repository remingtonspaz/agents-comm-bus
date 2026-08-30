import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import {
  CommLeaseArbiter,
  commLeasePath,
  nudgeLeaseReacquire,
  wrapWithLease,
  type LeaseRecord,
  type SelfIdentity,
} from "../../core-daemon/runtime/comm-lease.js";
import {
  classifyCommLeaseOwner,
  commLeaseLockRoot,
  DEFAULT_COMM_LEASE_SWEEP_INTERVAL_MS,
  runCommLeaseDaemonBootstrap,
  runCommLeaseSweep,
  startCommLeaseSweep,
} from "../../core-daemon/runtime/comm-lease-sweep.js";
import { computeCommLeaseEligibility } from "../../core-daemon/runtime/comm-lease-eligibility.js";
import { createSessionOwnerLiveness } from "../../core-daemon/runtime/session-owner-liveness.js";
import { scopeKey } from "../../core-daemon/runtime/scope-release-reconcile.js";
import { ensureRegistrationForAccount } from "../../core-daemon/runtime/ensure-registration.js";
import type { CommAdapterFactory } from "../../core-daemon/runtime/comm-factory.js";
import { sessionFixture } from "./_session-fixture.js";

registerTempDirCleanup();

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const OUR_ROOT = "C:/Users/me/.agents-comm-bus-discovery";
const FOREIGN_ROOT = "C:/Users/me/other-discovery";

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

function leaseRecord(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    comm_id: "telegram",
    resource_id: "bot-1",
    pid: 2000,
    stateRoot: "/state/h",
    checkoutRoot: "/checkout/h",
    daemonBin: null,
    daemonVersion: "0.0.0",
    authorityRank: "worktree",
    acquiredAt: 0,
    renewedAt: 9_500,
    lastIpcServedAt: 9_500,
    ...over,
  };
}

function registration(
  over: Partial<AccountRegistration> & { bot_user_id: string },
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: `reg-${over.bot_user_id}`,
    project: "D:/proj/a",
    agent: CLAUDE,
    comm: TELEGRAM,
    account_label: over.account_label ?? "main",
    bot_user_id: over.bot_user_id,
    bot_username: null,
    credentials_ref: "file:/tmp/token.json",
    activation: over.activation ?? "lazy",
    created_at: 1,
    updated_at: 1,
    ...over,
  } as AccountRegistration;
}

class FakeAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly allowedSenderIds: readonly string[] = [];
  startCount = 0;
  stopCount = 0;

  constructor(readonly accountId: AccountId) {}

  exclusiveResource() {
    return { resourceId: String(this.accountId) };
  }

  async start(): Promise<void> {
    this.startCount += 1;
  }
  async stop(): Promise<void> {
    this.stopCount += 1;
  }
  onInbound(): void {}
  onConnectionState(): void {}
  async send(): Promise<never> {
    throw new Error("not used");
  }
  reportPressure() {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure() {
    return "transient" as const;
  }
}

class RecordingFactory implements CommAdapterFactory {
  readonly commId = TELEGRAM;
  readonly adapters = new Map<string, FakeAdapter>();

  async resolveCredentials() {
    return { status: "ok" as const, credentials: {} };
  }

  create(_credentials: Record<string, unknown>, accountId: AccountId): CommAdapter {
    const adapter = new FakeAdapter(accountId);
    this.adapters.set(String(accountId), adapter);
    return adapter;
  }
}

async function makeHarness(dir: string) {
  const storage = await openSqliteStorage(path.join(dir, "db.sqlite"));
  const transcripts = new JsonlTranscriptStore(dir);
  const audit = new JsonlAuditStore(dir);
  const blobs = new ContentAddressedBlobStore(dir);
  const bus = new MessageBus({
    project: "D:/proj/a",
    storage,
    transcripts,
    audit,
    blobs,
    comms: [],
  });
  return { storage, transcripts, audit, blobs, bus };
}

async function writeLeaseFile(
  home: string,
  record: LeaseRecord,
): Promise<string> {
  const leasePath = commLeasePath(record.comm_id, record.resource_id, home);
  await mkdir(path.dirname(leasePath), { recursive: true });
  await writeFile(leasePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return leasePath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setImmediate(r));
  }
}

function makeTimers() {
  const handles = new Map<number, () => void>();
  let nextId = 1;
  return {
    setIntervalFn: (fn: () => void) => {
      const id = nextId++;
      handles.set(id, fn);
      return id;
    },
    clearIntervalFn: (h: unknown) => {
      handles.delete(h as number);
    },
    fire: (id: number) => {
      handles.get(id)?.();
    },
    count: () => handles.size,
  };
}

function makeSweepHoldGate() {
  let release: (() => void) | undefined;
  const hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  return { hold, release: () => release?.() };
}

describe("AGE-102 comm lease owner liveness (pure)", () => {
  it("definitely dead when pid is absent", () => {
    assert.equal(
      classifyCommLeaseOwner({ pid: 42, process_start_time: 100 }, { isPidAlive: () => false }),
      "definitely_dead",
    );
  });

  it("definitely dead on definite process-start mismatch while pid is alive", () => {
    assert.equal(
      classifyCommLeaseOwner(
        { pid: 42, process_start_time: 100 },
        {
          isPidAlive: () => true,
          readProcessStartEpochMs: () => 200,
        },
      ),
      "definitely_dead",
    );
  });

  it("retains live matching identity", () => {
    assert.equal(
      classifyCommLeaseOwner(
        { pid: 42, process_start_time: 100 },
        {
          isPidAlive: () => true,
          readProcessStartEpochMs: () => 100,
        },
      ),
      "retain",
    );
  });

  it("retains legacy live lease without process_start_time", () => {
    assert.equal(
      classifyCommLeaseOwner({ pid: 42 }, { isPidAlive: () => true }),
      "retain",
    );
  });

  it("retains when process-start probe is inconclusive", () => {
    assert.equal(
      classifyCommLeaseOwner(
        { pid: 42, process_start_time: 100 },
        {
          isPidAlive: () => true,
          readProcessStartEpochMs: () => null,
        },
      ),
      "retain",
    );
  });

  it("never reaps based only on renewedAt age", () => {
    assert.equal(
      classifyCommLeaseOwner(
        leaseRecord({ renewedAt: 0, process_start_time: 100 }),
        {
          isPidAlive: () => true,
          readProcessStartEpochMs: () => 100,
        },
      ),
      "retain",
    );
  });
});

describe("AGE-102 runCommLeaseSweep (real path)", () => {
  it("CAS-deletes a definitely-dead pid lease", async () => {
    const home = await makeTempDir("acb-age102-dead-");
    const leasePath = await writeLeaseFile(
      home,
      leaseRecord({ pid: 9999, resource_id: "dead-bot" }),
    );
    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: () => false,
    });
    assert.equal(counts.reaped, 1);
    assert.ok(!existsSync(leasePath));
  });

  it("deletes a live pid with definite process-start mismatch", async () => {
    const home = await makeTempDir("acb-age102-mismatch-");
    const leasePath = await writeLeaseFile(
      home,
      leaseRecord({ pid: 42, process_start_time: 100, resource_id: "mismatch-bot" }),
    );
    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: () => true,
      ownerLivenessOptions: { readProcessStartEpochMs: () => 200 },
    });
    assert.equal(counts.reaped, 1);
    assert.ok(!existsSync(leasePath));
  });

  it("retains live, legacy, and inconclusive records", async () => {
    const home = await makeTempDir("acb-age102-retain-");
    await writeLeaseFile(home, leaseRecord({ pid: 1, process_start_time: 10, resource_id: "live" }));
    await writeLeaseFile(home, leaseRecord({ pid: 2, resource_id: "legacy" }));
    await writeLeaseFile(
      home,
      leaseRecord({ pid: 3, process_start_time: 30, resource_id: "inconclusive" }),
    );
    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: (pid) => pid === 1 || pid === 2 || pid === 3,
      ownerLivenessOptions: {
        readProcessStartEpochMs: (pid) => {
          if (pid === 1) return 10;
          if (pid === 3) return null;
          return null;
        },
      },
    });
    assert.equal(counts.reaped, 0);
    assert.equal(counts.retained, 3);
    assert.ok(existsSync(commLeasePath("telegram", "live", home)));
    assert.ok(existsSync(commLeasePath("telegram", "legacy", home)));
    assert.ok(existsSync(commLeasePath("telegram", "inconclusive", home)));
  });

  it("survives byte-changed record between inspection and guarded re-read", async () => {
    const home = await makeTempDir("acb-age102-cas-");
    const record = leaseRecord({ pid: 77, resource_id: "cas-bot" });
    const leasePath = await writeLeaseFile(home, record);
    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: () => false,
      afterGuardAcquired: async (pathOnDisk) => {
        await writeFile(
          pathOnDisk,
          `${JSON.stringify({ ...record, renewedAt: 99_999 }, null, 2)}\n`,
          "utf8",
        );
      },
    });
    assert.equal(counts.cas_lost, 1);
    assert.equal(counts.reaped, 0);
    assert.ok(existsSync(leasePath));
  });

  it("concurrent sweepers yield one deletion", async () => {
    const home = await makeTempDir("acb-age102-concurrent-");
    await writeLeaseFile(home, leaseRecord({ pid: 88, resource_id: "race-bot" }));
    const [a, b] = await Promise.all([
      runCommLeaseSweep({ homeDir: home, isPidAlive: () => false }),
      runCommLeaseSweep({ homeDir: home, isPidAlive: () => false }),
    ]);
    assert.equal(a.reaped + b.reaped, 1);
    assert.equal(a.cas_lost + b.cas_lost + a.guard_contended + b.guard_contended, 1);
    assert.ok(!existsSync(commLeasePath("telegram", "race-bot", home)));
  });

  it("ignores malformed JSON and .guard files safely", async () => {
    const home = await makeTempDir("acb-age102-malformed-");
    const commDir = path.join(commLeaseLockRoot(home), "telegram");
    await mkdir(commDir, { recursive: true });
    await writeFile(path.join(commDir, "bad.json"), "{not json", "utf8");
    await writeFile(path.join(commDir, "good-bot.json.guard"), "1:2\n", "utf8");
    const counts = await runCommLeaseSweep({ homeDir: home, isPidAlive: () => false });
    assert.equal(counts.malformed, 1);
    assert.equal(counts.reaped, 0);
  });
});

describe("AGE-102 recovery after reap (real path)", () => {
  it("nudges a dormant denied wrapper to start immediately", async () => {
    const home = await makeTempDir("acb-age102-nudge-");
    const alive = new Set<number>([300]);
    const holderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 300, authorityRank: "main-dev" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    await holderArb.tryAcquire("fakecomm", "nudge-bot");

    const contenderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 310, authorityRank: "worktree" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    const timers = makeTimers();
    const inner = {
      id: "fakecomm" as CommId,
      accountId: "nudge-bot" as AccountId,
      allowedSenderIds: [] as readonly string[],
      startCount: 0,
      stopCount: 0,
      exclusiveResource: () => ({ resourceId: "nudge-bot" }),
      async start() {
        this.startCount += 1;
      },
      async stop() {
        this.stopCount += 1;
      },
      onInbound() {},
      onConnectionState() {},
      async send(): Promise<never> {
        throw new Error("not used");
      },
      reportPressure() {
        return { backlog: 0, rateLimited: false };
      },
      classifyFailure() {
        return "transient" as const;
      },
    };
    const wrapped = wrapWithLease(inner as unknown as CommAdapter, contenderArb, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      reacquireIntervalMs: 60_000,
      log: () => {},
    });
    await wrapped.start();
    assert.equal(inner.startCount, 0);

    alive.delete(300);
    await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
    });
    assert.ok(!existsSync(commLeasePath("fakecomm", "nudge-bot", home)));

    assert.equal(nudgeLeaseReacquire("fakecomm", "nudge-bot"), true);
    await waitFor(() => inner.startCount === 1);
    await wrapped.stop();
  });

  it("keeps adapter stopped when foreign eligibility blocks reacquire", async () => {
    const dir = await makeTempDir("acb-age102-foreign-");
    const harness = await makeHarness(dir);
    const home = await makeTempDir("acb-age102-foreign-home-");
    const reg = registration({ bot_user_id: "foreign-bot" });
    await harness.storage.putAccountRegistration(reg);
    const session = sessionFixture({
      session_id: "s-foreign",
      project: reg.project,
      agent: CLAUDE,
      lease_owner_daemon_discovery_root: FOREIGN_ROOT,
      lease_owner_process_pid: 500,
      lease_owner_process_registered_at: Date.now(),
      lease_owner_process_start_time: 100,
    });
    await harness.storage.upsertSession(session);

    const sessionOwnerIsLive = createSessionOwnerLiveness({
      isPidAlive: () => true,
      readProcessStartEpochMs: () => 100,
    });
    const eligible = computeCommLeaseEligibility({
      registration: reg,
      discoveryRoot: OUR_ROOT,
      sessions: [session],
      sessionOwnerIsLive,
    });
    assert.equal(eligible, false);

    const alive = new Set<number>([400]);
    await writeLeaseFile(
      home,
      leaseRecord({
        comm_id: TELEGRAM,
        resource_id: "foreign-bot",
        pid: 400,
        authorityRank: "main-dev",
      }),
    );

    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 410, authorityRank: "worktree" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });

    const factory = new RecordingFactory();
    const inner = factory.create({}, reg.bot_user_id as AccountId);
    const wrapped = wrapWithLease(inner, arb, {
      leaseEligible: async () => eligible,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      reacquireIntervalMs: 60_000,
      log: () => {},
    });
    harness.bus.registerComm(wrapped);
    await wrapped.start();
    assert.equal(inner.startCount, 0);

    alive.delete(400);
    await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      recovery: {
        storage: harness.storage,
        activeScopes: new Set([scopeKey(CLAUDE, reg.project, null)]),
        ensure: {
          factories: [factory],
          bus: harness.bus,
          bridges: [],
          storage: harness.storage,
          env: process.env,
          blobs: harness.blobs,
          stateRoot: dir,
          leaseArbiter: arb,
          inFlight: new Set(),
          discoveryRoot: OUR_ROOT,
          sessionOwnerIsLive,
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(inner.startCount, 0);
    await wrapped.stop();
    await harness.storage.close();
  });

  it("ensures desired eager registration when no wrapper exists", async () => {
    const dir = await makeTempDir("acb-age102-eager-");
    const harness = await makeHarness(dir);
    const home = await makeTempDir("acb-age102-eager-home-");
    const reg = registration({ bot_user_id: "eager-bot", activation: "eager" });
    await harness.storage.putAccountRegistration(reg);
    await writeLeaseFile(
      home,
      leaseRecord({ comm_id: TELEGRAM, resource_id: "eager-bot", pid: 1 }),
    );

    const factory = new RecordingFactory();
    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: process.pid }),
      lastIpcServedAt: () => Date.now(),
      homeDir: home,
      isPidAlive: () => false,
      now: () => Date.now(),
    });

    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: () => false,
      recovery: {
        storage: harness.storage,
        activeScopes: new Set(),
        ensure: {
          factories: [factory],
          bus: harness.bus,
          bridges: [],
          storage: harness.storage,
          env: process.env,
          blobs: harness.blobs,
          stateRoot: dir,
          leaseArbiter: arb,
          inFlight: new Set(),
          discoveryRoot: OUR_ROOT,
          sessionOwnerIsLive: createSessionOwnerLiveness(),
        },
      },
    });
    assert.equal(counts.reaped, 1);
    assert.equal(counts.recovered, 1);
    assert.equal(harness.bus.listComms().length, 1);
    assert.equal(factory.adapters.get("eager-bot")?.startCount, 1);
    await harness.storage.close();
  });

  it("does not ensure undesired lazy registration after deletion", async () => {
    const dir = await makeTempDir("acb-age102-lazy-");
    const harness = await makeHarness(dir);
    const home = await makeTempDir("acb-age102-lazy-home-");
    const reg = registration({ bot_user_id: "lazy-bot", activation: "lazy" });
    await harness.storage.putAccountRegistration(reg);
    await writeLeaseFile(
      home,
      leaseRecord({ comm_id: TELEGRAM, resource_id: "lazy-bot", pid: 1 }),
    );

    const factory = new RecordingFactory();
    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: process.pid }),
      lastIpcServedAt: () => Date.now(),
      homeDir: home,
      isPidAlive: () => false,
    });

    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: () => false,
      recovery: {
        storage: harness.storage,
        activeScopes: new Set(),
        ensure: {
          factories: [factory],
          bus: harness.bus,
          bridges: [],
          storage: harness.storage,
          env: process.env,
          blobs: harness.blobs,
          stateRoot: dir,
          leaseArbiter: arb,
          inFlight: new Set(),
        },
      },
    });
    assert.equal(counts.reaped, 1);
    assert.equal(counts.recovered, 0);
    assert.equal(harness.bus.listComms().length, 0);
    await harness.storage.close();
  });

  it("dead lease + dormant denied wrapper starts via sweep recovery", async () => {
    const dir = await makeTempDir("acb-age102-sweep-nudge-");
    const harness = await makeHarness(dir);
    const home = await makeTempDir("acb-age102-sweep-nudge-home-");
    const reg = registration({ bot_user_id: "sweep-nudge-bot" });
    await harness.storage.putAccountRegistration(reg);

    const alive = new Set<number>([400]);
    await writeLeaseFile(
      home,
      leaseRecord({
        comm_id: TELEGRAM,
        resource_id: "sweep-nudge-bot",
        pid: 400,
        authorityRank: "main-dev",
      }),
    );

    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 410, authorityRank: "worktree" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    const factory = new RecordingFactory();
    const inner = factory.create({}, reg.bot_user_id as AccountId);
    const wrapped = wrapWithLease(inner, arb, {
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      reacquireIntervalMs: 60_000,
      log: () => {},
    });
    harness.bus.registerComm(wrapped);
    await wrapped.start();
    assert.equal(inner.startCount, 0);

    alive.delete(400);
    const counts = await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      recovery: {
        storage: harness.storage,
        activeScopes: new Set([scopeKey(CLAUDE, reg.project, null)]),
        ensure: {
          factories: [factory],
          bus: harness.bus,
          bridges: [],
          storage: harness.storage,
          env: process.env,
          blobs: harness.blobs,
          stateRoot: dir,
          leaseArbiter: arb,
          inFlight: new Set(),
          discoveryRoot: OUR_ROOT,
          sessionOwnerIsLive: createSessionOwnerLiveness(),
        },
      },
    });
    assert.equal(counts.reaped, 1);
    assert.equal(counts.recovered, 1);
    await waitFor(() => inner.startCount === 1);
    await wrapped.stop();
    await harness.storage.close();
  });
});

describe("AGE-102 comm lease sweep scheduler (real path)", () => {
  it("stop during in-flight sweep does not schedule replays", async () => {
    const home = await makeTempDir("acb-age102-stop-fence-");
    await writeLeaseFile(home, leaseRecord({ pid: 1, resource_id: "stop-fence-bot" }));
    const gate = makeSweepHoldGate();
    let sweepCount = 0;
    const handle = startCommLeaseSweep({
      homeDir: home,
      runOnStart: true,
      isPidAlive: () => false,
      intervalMs: DEFAULT_COMM_LEASE_SWEEP_INTERVAL_MS,
      setIntervalFn: () => null,
      sweepHold: async () => {
        sweepCount += 1;
        await gate.hold();
      },
    });
    await waitFor(() => sweepCount === 1);
    handle.stop();
    gate.release();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sweepCount, 1, "stop must fence further replays");
  });

  it("pending tick replays after an in-flight sweep completes", async () => {
    const home = await makeTempDir("acb-age102-replay-");
    await writeLeaseFile(home, leaseRecord({ pid: 1, resource_id: "replay-a" }));
    const gate = makeSweepHoldGate();
    let sweepCount = 0;
    let intervalTick: (() => void) | null = null;
    const handle = startCommLeaseSweep({
      homeDir: home,
      runOnStart: true,
      isPidAlive: () => false,
      intervalMs: 60_000,
      setIntervalFn: (fn) => {
        intervalTick = fn as () => void;
        return null;
      },
      sweepHold: async () => {
        sweepCount += 1;
        if (sweepCount === 1) await gate.hold();
      },
    });
    await waitFor(() => sweepCount === 1);
    assert.ok(intervalTick, "interval tick captured immediately on scheduler start");
    intervalTick!();
    gate.release();
    await waitFor(() => sweepCount >= 2);
    handle.stop();
  });

  it("installs periodic interval immediately at 1x intervalMs", async () => {
    const home = await makeTempDir("acb-age102-interval-");
    let intervalMsUsed: number | null = null;
    let tickCaptured = false;
    const handle = startCommLeaseSweep({
      homeDir: home,
      runOnStart: false,
      intervalMs: 5_000,
      setIntervalFn: (fn, ms) => {
        intervalMsUsed = ms;
        tickCaptured = true;
        return 1;
      },
    });
    assert.equal(intervalMsUsed, 5_000);
    assert.equal(tickCaptured, true);
    handle.stop();
  });

  it("stamps native process_start_time on acquire when probe succeeds", async () => {
    const home = await makeTempDir("acb-age102-stamp-");
    const nativeIdentity = 4242;
    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 501 }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 0,
      readProcessStartIdentity: () => nativeIdentity,
    });
    const result = await arb.tryAcquire("telegram", "stamp-bot");
    assert.equal(result.ok, true);
    const raw = await readFile(commLeasePath("telegram", "stamp-bot", home), "utf8");
    const parsed = JSON.parse(raw) as LeaseRecord;
    assert.equal(parsed.process_start_time, nativeIdentity);
  });

  it("omits process_start_time when native probe returns null", async () => {
    const home = await makeTempDir("acb-age102-no-stamp-");
    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 502 }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 0,
      readProcessStartIdentity: () => null,
    });
    const result = await arb.tryAcquire("telegram", "no-stamp-bot");
    assert.equal(result.ok, true);
    const raw = await readFile(commLeasePath("telegram", "no-stamp-bot", home), "utf8");
    const parsed = JSON.parse(raw) as LeaseRecord;
    assert.equal(parsed.process_start_time, undefined);
  });
});

describe("AGE-102 fix-round: daemon bootstrap ordering (real path)", () => {
  it("runs boot sweep before periodic, restore, and eager reconcile", async () => {
    const events: string[] = [];
    let sweepDone = false;
    await runCommLeaseDaemonBootstrap({
      bootSweep: async () => {
        events.push("sweep-start");
        await new Promise((r) => setTimeout(r, 10));
        sweepDone = true;
        events.push("sweep-end");
      },
      startPeriodicSweep: () => {
        events.push("periodic");
        assert.equal(sweepDone, true, "periodic must start only after boot sweep");
        return { stop() {} };
      },
      bootRestore: async () => {
        events.push("restore");
        assert.equal(sweepDone, true, "restore must run after boot sweep");
      },
      eagerReconcile: async () => {
        events.push("eager");
      },
      onBootSweepFailed: async () => {
        events.push("sweep-failed");
      },
    });
    assert.deepEqual(events, ["sweep-start", "sweep-end", "periodic", "restore", "eager"]);
  });

  it("skips periodic but still runs restore/eager when boot sweep fails", async () => {
    const events: string[] = [];
    const periodic = await runCommLeaseDaemonBootstrap({
      bootSweep: async () => {
        events.push("sweep");
        throw new Error("boot sweep boom");
      },
      startPeriodicSweep: () => {
        events.push("periodic");
        return { stop() {} };
      },
      bootRestore: async () => {
        events.push("restore");
      },
      eagerReconcile: async () => {
        events.push("eager");
      },
      onBootSweepFailed: async () => {
        events.push("sweep-failed");
      },
    });
    assert.equal(periodic, null);
    assert.deepEqual(events, ["sweep", "sweep-failed", "restore", "eager"]);
  });
});

describe("AGE-102 fix-round: guard released before recovery (real path)", () => {
  it("recovery observes guard absent and acquire succeeds without contention", async () => {
    const dir = await makeTempDir("acb-age102-guard-release-");
    const harness = await makeHarness(dir);
    const home = await makeTempDir("acb-age102-guard-release-home-");
    const reg = registration({ bot_user_id: "guard-bot", activation: "eager" });
    await harness.storage.putAccountRegistration(reg);
    const leasePath = await writeLeaseFile(
      home,
      leaseRecord({ comm_id: TELEGRAM, resource_id: "guard-bot", pid: 1 }),
    );
    const guardPath = `${leasePath}.guard`;

    const arb = new CommLeaseArbiter({
      self: selfIdentity({ pid: process.pid }),
      lastIpcServedAt: () => Date.now(),
      homeDir: home,
      isPidAlive: () => false,
    });
    const factory = new RecordingFactory();
    let guardAbsent = false;
    let acquireOk = false;

    await runCommLeaseSweep({
      homeDir: home,
      isPidAlive: () => false,
      beforeRecovery: async (pathOnDisk) => {
        assert.equal(pathOnDisk, leasePath);
        guardAbsent = !existsSync(guardPath);
        const result = await arb.tryAcquire(TELEGRAM, "guard-bot");
        acquireOk = result.ok;
      },
      recovery: {
        storage: harness.storage,
        activeScopes: new Set(),
        ensure: {
          factories: [factory],
          bus: harness.bus,
          bridges: [],
          storage: harness.storage,
          env: process.env,
          blobs: harness.blobs,
          stateRoot: dir,
          leaseArbiter: arb,
          inFlight: new Set(),
        },
      },
    });

    assert.equal(guardAbsent, true);
    assert.equal(acquireOk, true);
    assert.equal(existsSync(commLeasePath(TELEGRAM, "guard-bot", home)), true);
    await harness.storage.close();
  });
});

describe("AGE-102 fix-round: nudge slow-poll restoration (real path)", () => {
  it("reinstalls slow poll after eligibility-denied nudge", async () => {
    const home = await makeTempDir("acb-age102-nudge-deny-");
    const alive = new Set<number>([300]);
    const holderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 300, authorityRank: "main-dev" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    await holderArb.tryAcquire("fakecomm", "deny-nudge-bot");

    const contenderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 310, authorityRank: "worktree" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    const timers = makeTimers();
    const inner = {
      id: "fakecomm" as CommId,
      accountId: "deny-nudge-bot" as AccountId,
      allowedSenderIds: [] as readonly string[],
      startCount: 0,
      stopCount: 0,
      exclusiveResource: () => ({ resourceId: "deny-nudge-bot" }),
      async start() {
        this.startCount += 1;
      },
      async stop() {
        this.stopCount += 1;
      },
      onInbound() {},
      onConnectionState() {},
      async send(): Promise<never> {
        throw new Error("not used");
      },
      reportPressure() {
        return { backlog: 0, rateLimited: false };
      },
      classifyFailure() {
        return "transient" as const;
      },
    };
    const wrapped = wrapWithLease(inner as unknown as CommAdapter, contenderArb, {
      leaseEligible: async () => false,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      reacquireIntervalMs: 60_000,
      log: () => {},
    });
    await wrapped.start();
    assert.equal(timers.count(), 1);
    assert.equal(nudgeLeaseReacquire("fakecomm", "deny-nudge-bot"), true);
    await waitFor(() => timers.count() === 1);
    assert.equal(inner.startCount, 0);
    await wrapped.stop();
  });

  it("reinstalls slow poll after tryAcquire error on nudge", async () => {
    const home = await makeTempDir("acb-age102-nudge-error-");
    const alive = new Set<number>([300]);
    const holderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 300, authorityRank: "main-dev" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    await holderArb.tryAcquire("fakecomm", "error-nudge-bot");

    const contenderArb = new CommLeaseArbiter({
      self: selfIdentity({ pid: 320, authorityRank: "worktree" }),
      lastIpcServedAt: () => 0,
      homeDir: home,
      isPidAlive: (pid) => alive.has(pid),
      now: () => 0,
    });
    const timers = makeTimers();
    const inner = {
      id: "fakecomm" as CommId,
      accountId: "error-nudge-bot" as AccountId,
      allowedSenderIds: [] as readonly string[],
      startCount: 0,
      stopCount: 0,
      exclusiveResource: () => ({ resourceId: "error-nudge-bot" }),
      async start() {
        this.startCount += 1;
      },
      async stop() {
        this.stopCount += 1;
      },
      onInbound() {},
      onConnectionState() {},
      async send(): Promise<never> {
        throw new Error("not used");
      },
      reportPressure() {
        return { backlog: 0, rateLimited: false };
      },
      classifyFailure() {
        return "transient" as const;
      },
    };
    const wrapped = wrapWithLease(inner as unknown as CommAdapter, contenderArb, {
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      reacquireIntervalMs: 60_000,
      log: () => {},
    });
    await wrapped.start();
    assert.equal(timers.count(), 1, "denied start arms slow poll");

    contenderArb.tryAcquire = async () => {
      throw new Error("acquire blew up");
    };
    assert.equal(nudgeLeaseReacquire("fakecomm", "error-nudge-bot"), true);
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.count(), 1, "slow poll must be reinstalled after errored nudge");
    await wrapped.stop();
  });
});

describe("AGE-102 ensure path after deletion (exact registration)", () => {
  it("uses ensureRegistrationForAccount for active-scope lazy registration", async () => {
    const dir = await makeTempDir("acb-age102-scope-");
    const harness = await makeHarness(dir);
    const reg = registration({ bot_user_id: "scope-bot", activation: "lazy" });
    await harness.storage.putAccountRegistration(reg);
    const factory = new RecordingFactory();
    const arb = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 0,
      homeDir: await makeTempDir("acb-age102-scope-home-"),
      isPidAlive: () => true,
    });
    const outcome = await ensureRegistrationForAccount(reg, {
      factories: [factory],
      bus: harness.bus,
      bridges: [],
      storage: harness.storage,
      env: process.env,
      blobs: harness.blobs,
      stateRoot: dir,
      leaseArbiter: arb,
      inFlight: new Set(),
      discoveryRoot: OUR_ROOT,
      sessionOwnerIsLive: createSessionOwnerLiveness(),
    });
    assert.equal(outcome.status, "started");
    await harness.storage.close();
  });
});

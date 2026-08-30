import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
  SessionId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import {
  decideContention,
  CommLeaseArbiter,
  type LeaseRecord,
  type SelfIdentity,
} from "../../core-daemon/runtime/comm-lease.js";
import { computeCommLeaseEligibility } from "../../core-daemon/runtime/comm-lease-eligibility.js";
import {
  classifySessionOwnerProcess,
  createSessionOwnerLiveness,
} from "../../core-daemon/runtime/session-owner-liveness.js";
import {
  scopeKey,
  DEFAULT_SCOPE_RELEASE_GRACE_MS,
} from "../../core-daemon/runtime/scope-release-reconcile.js";
import { removeLiveAdapter } from "../../core-daemon/runtime/comm-adapter-lifecycle.js";
import {
  runSessionEndSweep,
  startSessionEndSweep,
} from "../../core-daemon/runtime/session-end-sweep.js";
import { ensureCommsForSession } from "../../core-daemon/daemon.js";
import { sessionFixture } from "./_session-fixture.js";
import {
  serializeAccountLabelScope,
} from "../../core-daemon/session-label-scope.js";
import type { CommAdapterFactory } from "../../core-daemon/runtime/comm-factory.js";
import {
  compareProcessStartIdentity,
  processStartIdentityMatches,
  readProcessStartIdentity,
  currentProcessStartEpochMs,
} from "../../core-daemon/runtime/process-start-epoch.js";

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

function holder(over: Partial<LeaseRecord> = {}): LeaseRecord {
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

function makeHarness(dir: string) {
  const storage = openSqliteStorage(path.join(dir, "db.sqlite"));
  const transcripts = new JsonlTranscriptStore(dir);
  const audit = new JsonlAuditStore(dir);
  const blobs = new ContentAddressedBlobStore(dir);
  return storage.then((s) => {
    const bus = new MessageBus({
      project: "D:/proj/a",
      storage: s,
      transcripts,
      audit,
      blobs,
      comms: [],
    });
    return { storage: s, transcripts, audit, blobs, bus };
  });
}

function makeFakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  return {
    pending,
    setTimeoutFn(fn: () => void, ms: number) {
      const id = nextId++;
      pending.push({ fn, ms, id });
      return { id };
    },
    clearTimeoutFn(handle: { id: number }) {
      const idx = pending.findIndex((p) => p.id === handle.id);
      if (idx >= 0) pending.splice(idx, 1);
    },
    fireAll() {
      const batch = [...pending];
      pending.length = 0;
      for (const item of batch) item.fn();
    },
  };
}

function reconcileSweepInput(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  factory: RecordingFactory,
  activeScopes: Set<string>,
  reconcileState: { zeroLiveSince: Map<string, number>; graceTimers?: Map<string, unknown> },
  leaseArbiter: CommLeaseArbiter,
  sessionOwnerIsLive: () => boolean,
) {
  return {
    storage: harness.storage,
    bus: harness.bus,
    bridges: [],
    factories: [factory],
    activeScopes,
    leaseArbiter,
    sessionOwnerIsLive,
    removeAdapter: removeLiveAdapter,
    state: reconcileState,
    discoveryRoot: OUR_ROOT,
  };
}

describe("AGE-101 live lease eligibility (pure)", () => {
  it("DENIES higher-rank contender when injected eligibility is false", () => {
    const d = decideContention({
      commId: "telegram",
      resourceId: "bot-1",
      self: selfIdentity({ authorityRank: "main-dev" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "worktree" }),
      now: 10_000,
      isPidAlive: () => true,
      stalenessMs: 90_000,
      ipcRecencyMarginMs: 30_000,
      eligible: false,
    });
    assert.equal(d.take, false);
    assert.equal((d as { reason: string }).reason, "not-eligible-for-scope");
  });

  it("same-scope rank arbitration unchanged when eligible (regression)", () => {
    const d = decideContention({
      commId: "telegram",
      resourceId: "bot-1",
      self: selfIdentity({ authorityRank: "main-dev" }),
      selfLastIpcServedAt: 10_000,
      existing: holder({ authorityRank: "production" }),
      now: 10_000,
      isPidAlive: () => true,
      stalenessMs: 90_000,
      ipcRecencyMarginMs: 30_000,
      eligible: true,
    });
    assert.equal(d.take, true);
    assert.equal((d as { reason: string }).reason, "higher-rank");
  });

  it("computeCommLeaseEligibility declines foreign discovery-root stamped live owner", () => {
    const reg = registration({ bot_user_id: "8950482517" });
    const session = sessionFixture({
      session_id: "s-foreign" as SessionId,
      agent: CLAUDE,
      project: reg.project,
      lease_owner_process_pid: 42,
      lease_owner_process_registered_at: 1_000,
      lease_owner_process_start_time: 500,
      lease_owner_daemon_discovery_root: FOREIGN_ROOT,
    });
    const live = createSessionOwnerLiveness({
      now: () => 2_000,
      isPidAlive: () => true,
      readProcessStartEpochMs: () => 500,
    });
    assert.equal(
      computeCommLeaseEligibility({
        registration: reg,
        discoveryRoot: OUR_ROOT,
        sessions: [session],
        sessionOwnerIsLive: live,
      }),
      false,
    );
  });
});

describe("AGE-101 ensureCommsForSession wires eligibility (real path)", () => {
  it("foreign-discovery-root live owner blocks adapter start on ensure path", async () => {
    const dir = await makeTempDir("acb-age101-ensure-foreign-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "blocked-bot" });
    await harness.storage.putAccountRegistration(reg);
    await harness.storage.upsertSession(
      sessionFixture({
        session_id: "s-foreign" as SessionId,
        agent: CLAUDE,
        project: reg.project,
        lease_owner_process_pid: 42,
        lease_owner_process_registered_at: 1_000,
        lease_owner_process_start_time: 500,
        lease_owner_daemon_discovery_root: FOREIGN_ROOT,
      }),
    );
    const sessionOwnerIsLive = createSessionOwnerLiveness({
      now: () => 2_000,
      isPidAlive: () => true,
      readProcessStartEpochMs: () => 500,
    });
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity({ authorityRank: "main-dev" }),
      lastIpcServedAt: () => 10_000,
      homeDir: dir,
    });

    await ensureCommsForSession({
      project: reg.project,
      agent: CLAUDE,
      factories: [factory],
      bus: harness.bus,
      bridges: [],
      storage: harness.storage,
      env: {},
      blobs: harness.blobs,
      stateRoot: dir,
      leaseArbiter,
      inFlight: new Set<string>(),
      discoveryRoot: OUR_ROOT,
      sessionOwnerIsLive,
    });

    const adapter = factory.adapters.get("blocked-bot");
    assert.ok(adapter, "adapter constructed and registered");
    assert.equal(adapter!.startCount, 0, "lease eligibility blocks inner.start()");
    assert.ok(
      harness.bus.getComm(TELEGRAM, "blocked-bot" as AccountId),
      "wrapped adapter remains on bus without starting consumer",
    );

    await harness.storage.close();
  });
});

describe("AGE-101 pid+start-time liveness", () => {
  it("definite mismatch is dead", () => {
    const state = classifySessionOwnerProcess(
      {
        lease_holder_connection_id: null,
        lease_owner_process_pid: 99,
        lease_owner_process_registered_at: 1_000,
        lease_owner_process_start_time: 100,
      },
      {
        isPidAlive: () => true,
        readProcessStartEpochMs: () => 200,
        now: () => 2_000,
      },
    );
    assert.equal(state, "dead");
  });

  it("null probe is inconclusive — NOT dead within recency (fail-safe)", () => {
    const state = classifySessionOwnerProcess(
      {
        lease_holder_connection_id: null,
        lease_owner_process_pid: 99,
        lease_owner_process_registered_at: 1_000,
        lease_owner_process_start_time: 100,
      },
      {
        isPidAlive: () => true,
        readProcessStartEpochMs: () => null,
        now: () => 2_000,
      },
    );
    assert.equal(state, "live");
    assert.equal(compareProcessStartIdentity(100, 99, {}), "inconclusive");
  });

  it("definite match is live", () => {
    assert.equal(
      classifySessionOwnerProcess(
        {
          lease_holder_connection_id: null,
          lease_owner_process_pid: 99,
          lease_owner_process_registered_at: 1_000,
          lease_owner_process_start_time: 100,
        },
        {
          isPidAlive: () => true,
          readProcessStartEpochMs: () => 100,
          now: () => 2_000,
        },
      ),
      "live",
    );
  });

  it("stable linux identity: repeat-read same pid stays LIVE (injectable stat/boot_id)", () => {
    const statLine = "(42) R 0 1 42 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123456";
    const readProcStat = () => statLine;
    const readBootId = () => "fixed-boot-id";
    const identity = readProcessStartIdentity(42, { readProcStat, readBootId });
    assert.ok(identity != null);
    const session = {
      lease_holder_connection_id: null,
      lease_owner_process_pid: 42,
      lease_owner_process_registered_at: 1_000,
      lease_owner_process_start_time: identity,
    };
    const opts = {
      isPidAlive: () => true,
      readProcStat,
      readBootId,
      now: () => 2_000,
    };
    assert.equal(classifySessionOwnerProcess(session, opts), "live");
    assert.equal(classifySessionOwnerProcess(session, opts), "live");
    assert.equal(processStartIdentityMatches(identity!, 42, opts), true);
  });
});

describe("AGE-101 lazy scope release via startSessionEndSweep (real path)", () => {
  it("explicit exit hint releases on first pass (graceMs=0)", async () => {
    const dir = await makeTempDir("acb-age101-hint-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "hint-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const timers = makeFakeTimers();

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: false,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => false,
      ),
      reconcileState,
    });

    handle.requestEarlyReconcile();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(harness.bus.listComms().length, 0);
    assert.equal(activeScopes.size, 0);
    handle.stop();
    await harness.storage.close();
  });

  it("grace-window scope releases when scheduled timer fires", async () => {
    const dir = await makeTempDir("acb-age101-grace-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "grace-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const timers = makeFakeTimers();
    const clock = { t: 5_000 };

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: true,
      isPidAlive: () => true,
      now: () => clock.t,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => false,
      ),
      reconcileState,
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(harness.bus.listComms().length, 1, "first pass schedules grace");
    const graceTimers = timers.pending.filter(
      (p) => p.ms === DEFAULT_SCOPE_RELEASE_GRACE_MS,
    );
    assert.equal(graceTimers.length, 1);

    clock.t += DEFAULT_SCOPE_RELEASE_GRACE_MS;
    for (const item of timers.pending.filter(
      (p) => p.ms === DEFAULT_SCOPE_RELEASE_GRACE_MS,
    )) {
      item.fn();
    }
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(harness.bus.listComms().length, 0);
    handle.stop();
    await harness.storage.close();
  });

  it("returning live local session cancels pending grace release", async () => {
    const dir = await makeTempDir("acb-age101-cancel-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "cancel-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const timers = makeFakeTimers();
    let live = false;
    const clock = { t: 5_000 };

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: true,
      isPidAlive: () => true,
      now: () => clock.t,
      intervalMs: 60_000,
      setIntervalFn: (fn) => {
        fn();
        return null;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => live,
      ),
      reconcileState,
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      timers.pending.filter((p) => p.ms === DEFAULT_SCOPE_RELEASE_GRACE_MS).length,
      1,
    );

    live = true;
    await harness.storage.upsertSession(
      sessionFixture({
        session_id: "s-cancel-live" as SessionId,
        agent: CLAUDE,
        project: reg.project,
        lease_holder_connection_id: "conn-live",
      }),
    );
    const intervalBootstrap = timers.pending.find((p) => p.ms === 60_000);
    intervalBootstrap?.fn();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      timers.pending.filter((p) => p.ms === DEFAULT_SCOPE_RELEASE_GRACE_MS).length,
      0,
      "grace timer cancelled",
    );
    assert.equal(harness.bus.listComms().length, 1);

    handle.stop();
    await harness.storage.close();
  });

  it("foreign-root live same-scope session does NOT retain local lazy adapter", async () => {
    // Mutation guard: flipping isSessionLocalLiveOwner to treat foreign stamps as local
    // in scope-release-reconcile.ts MUST red this test (adapter retained). The foreign
    // session must survive the row-ender so discovery-root filtering is what releases.
    const dir = await makeTempDir("acb-age101-foreign-retain-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "foreign-retain-bot" });
    await harness.storage.putAccountRegistration(reg);
    const storedStart = 500;
    const foreignSessionId = "s-foreign-live" as SessionId;
    await harness.storage.upsertSession(
      sessionFixture({
        session_id: foreignSessionId,
        agent: CLAUDE,
        project: reg.project,
        lease_owner_process_pid: 42,
        lease_owner_process_registered_at: 1_000,
        lease_owner_process_start_time: storedStart,
        lease_owner_daemon_discovery_root: FOREIGN_ROOT,
      }),
    );
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const sessionOwnerIsLive = createSessionOwnerLiveness({
      now: () => 2_000,
      isPidAlive: () => true,
      readProcessStartEpochMs: () => storedStart,
    });

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: false,
      isPidAlive: () => true,
      ownerLivenessOptions: {
        isPidAlive: () => true,
        readProcessStartEpochMs: () => null,
        now: () => 2_000,
      },
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        sessionOwnerIsLive,
      ),
      reconcileState,
    });

    handle.requestEarlyReconcile();
    await new Promise((r) => setTimeout(r, 100));

    const stillActive = await harness.storage.getSession(foreignSessionId);
    assert.equal(
      stillActive?.status,
      "active",
      "live foreign session survives inconclusive row-ender",
    );
    assert.equal(
      harness.bus.listComms().length,
      0,
      "foreign owner does not count as local live",
    );
    handle.stop();
    await harness.storage.close();
  });

  it("missing-stamp local live session retains adapter (conservative)", async () => {
    const dir = await makeTempDir("acb-age101-missing-stamp-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "missing-stamp-bot" });
    await harness.storage.putAccountRegistration(reg);
    const livePid = process.pid;
    const liveStart =
      readProcessStartIdentity(livePid) ?? currentProcessStartEpochMs();
    await harness.storage.upsertSession(
      sessionFixture({
        session_id: "s-missing-stamp" as SessionId,
        agent: CLAUDE,
        project: reg.project,
        lease_owner_process_pid: livePid,
        lease_owner_process_registered_at: 1_000,
        lease_owner_process_start_time: liveStart,
        lease_owner_daemon_discovery_root: null,
      }),
    );
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const sessionOwnerIsLive = createSessionOwnerLiveness({
      now: () => 2_000,
      isPidAlive: (pid) => pid === livePid,
      readProcessStartEpochMs: () => liveStart,
    });

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: false,
      isPidAlive: (pid) => pid === livePid,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        sessionOwnerIsLive,
      ),
      reconcileState,
    });

    handle.requestEarlyReconcile();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(harness.bus.listComms().length, 1, "null stamp treated as local — retain");
    handle.stop();
    await harness.storage.close();
  });

  it("labeled sibling scope retains adapter when unscoped scope exits", async () => {
    const dir = await makeTempDir("acb-age101-sibling-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const labeledScope = serializeAccountLabelScope({ telegram: "subagent" })!;
    const unscopedReg = registration({ bot_user_id: "unscoped-bot", account_label: "main" });
    const labeledReg = registration({
      bot_user_id: "labeled-bot",
      account_label: "subagent",
    });
    await harness.storage.putAccountRegistration(unscopedReg);
    await harness.storage.putAccountRegistration(labeledReg);

    const unscopedAdapter = factory.create({}, unscopedReg.bot_user_id as AccountId);
    const labeledAdapter = factory.create({}, labeledReg.bot_user_id as AccountId);
    harness.bus.registerComm(unscopedAdapter);
    harness.bus.registerComm(labeledAdapter);
    await unscopedAdapter.start();
    await labeledAdapter.start();

    await harness.storage.upsertSession(
      sessionFixture({
        session_id: "s-labeled" as SessionId,
        agent: CLAUDE,
        project: unscopedReg.project,
        account_label_scope: labeledScope,
        lease_owner_process_pid: 42,
        lease_owner_process_registered_at: 1_000,
        lease_owner_process_start_time: 500,
        lease_owner_daemon_discovery_root: OUR_ROOT,
      }),
    );

    const activeScopes = new Set([
      scopeKey(CLAUDE, unscopedReg.project, null),
      scopeKey(CLAUDE, unscopedReg.project, labeledScope),
    ]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const sessionOwnerIsLive = createSessionOwnerLiveness({
      now: () => 2_000,
      isPidAlive: () => true,
      readProcessStartEpochMs: () => 500,
    });

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: false,
      isPidAlive: () => true,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        sessionOwnerIsLive,
      ),
      reconcileState,
    });

    handle.requestEarlyReconcile();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(
      harness.bus.getComm(TELEGRAM, "labeled-bot" as AccountId) != null,
      true,
      "labeled registration retained for live labeled scope",
    );
    assert.equal(
      harness.bus.getComm(TELEGRAM, "unscoped-bot" as AccountId),
      null,
      "unscoped registration removed when only labeled scope is live",
    );

    handle.stop();
    await harness.storage.close();
  });

  it("eager registration survives zero local sessions", async () => {
    const dir = await makeTempDir("acb-age101-eager-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "eager-bot", activation: "eager" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: false,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => false,
      ),
      reconcileState,
    });

    handle.requestEarlyReconcile();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(harness.bus.listComms().length, 1);
    handle.stop();
    await harness.storage.close();
  });

  it("runSessionEndSweep with pre-elapsed grace releases via sweep path", async () => {
    const dir = await makeTempDir("acb-age101-sweep-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "sweep-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const now = { t: DEFAULT_SCOPE_RELEASE_GRACE_MS + 1 };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => now.t,
    });

    reconcileState.zeroLiveSince.set(scopeKey(CLAUDE, reg.project, null), 0);

    const counts = await runSessionEndSweep({
      storage: harness.storage,
      now: () => now.t,
      isPidAlive: () => false,
      reconcile: {
        ...reconcileSweepInput(
          harness,
          factory,
          activeScopes,
          reconcileState,
          leaseArbiter,
          () => false,
        ),
        graceMs: DEFAULT_SCOPE_RELEASE_GRACE_MS,
      },
    });

    assert.ok(counts.reconcile);
    assert.equal(counts.reconcile.adapters_removed, 1);
    assert.equal(harness.bus.listComms().length, 0);

    await harness.storage.close();
  });
});

function makeSweepHoldGate(): { hold: () => Promise<void>; release: () => void } {
  let release!: () => void;
  let armed = true;
  const hold = () => {
    if (!armed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      release = () => {
        armed = false;
        resolve();
      };
    });
  };
  return { hold, release: () => release() };
}

describe("AGE-101 session-end-sweep replay + stop fence (real path)", () => {
  it("hint during in-flight sweep replays and releases", async () => {
    const dir = await makeTempDir("acb-age101-replay-hint-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "replay-hint-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const gate = makeSweepHoldGate();

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: true,
      sweepHold: gate.hold,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => false,
      ),
      reconcileState,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(harness.bus.listComms().length, 1, "in-flight sweep has not released yet");

    handle.requestEarlyReconcile();
    gate.release();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(harness.bus.listComms().length, 0, "replay after hint releases adapter");
    handle.stop();
    await harness.storage.close();
  });

  it("grace-expiry during in-flight sweep replays and releases", async () => {
    const dir = await makeTempDir("acb-age101-replay-grace-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "replay-grace-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const timers = makeFakeTimers();
    const clock = { t: 5_000 };
    let sweepPass = 0;
    const gate = makeSweepHoldGate();

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: true,
      now: () => clock.t,
      sweepHold: async () => {
        sweepPass += 1;
        if (sweepPass >= 2) await gate.hold();
      },
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => false,
      ),
      reconcileState,
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(harness.bus.listComms().length, 1);

    clock.t += DEFAULT_SCOPE_RELEASE_GRACE_MS;
    for (const item of timers.pending.filter(
      (p) => p.ms === DEFAULT_SCOPE_RELEASE_GRACE_MS,
    )) {
      item.fn();
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(harness.bus.listComms().length, 1, "grace tick blocked in-flight");

    gate.release();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(harness.bus.listComms().length, 0, "replay after grace releases adapter");
    handle.stop();
    await harness.storage.close();
  });

  it("stop during in-flight sweep does not schedule timers or replay", async () => {
    const dir = await makeTempDir("acb-age101-stop-fence-");
    const harness = await makeHarness(dir);
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "stop-fence-bot" });
    await harness.storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    harness.bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1_000,
    });
    const timers = makeFakeTimers();
    const gate = makeSweepHoldGate();

    const handle = startSessionEndSweep({
      storage: harness.storage,
      runOnStart: true,
      sweepHold: gate.hold,
      intervalMs: 60_000,
      setIntervalFn: () => null,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      reconcile: reconcileSweepInput(
        harness,
        factory,
        activeScopes,
        reconcileState,
        leaseArbiter,
        () => false,
      ),
      reconcileState,
    });
    await new Promise((r) => setTimeout(r, 20));

    handle.stop();
    handle.requestEarlyReconcile();
    gate.release();
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(
      timers.pending.filter((p) => p.ms === DEFAULT_SCOPE_RELEASE_GRACE_MS).length,
      0,
      "stop fence blocks grace scheduling after stop",
    );
    assert.equal(harness.bus.listComms().length, 1, "adapter not released after stop");
    await harness.storage.close();
  });
});

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
  reconcileLazyAdapterScopes,
  scopeKey,
  DEFAULT_SCOPE_RELEASE_GRACE_MS,
} from "../../core-daemon/runtime/scope-release-reconcile.js";
import { removeLiveAdapter } from "../../core-daemon/runtime/comm-adapter-lifecycle.js";
import { runSessionEndSweep } from "../../core-daemon/runtime/session-end-sweep.js";
import { sessionFixture } from "./_session-fixture.js";
import type { CommAdapterFactory } from "../../core-daemon/runtime/comm-factory.js";

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
    account_label: "main",
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

describe("AGE-101 pid+start-time liveness", () => {
  it("classifies reused pid with mismatched start-time as dead", () => {
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

  it("mutation: same start-time mismatch classified live would fail", () => {
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
    assert.notEqual(state, "live");
  });
});

describe("AGE-101 lazy scope release reconcile", () => {
  it("releases lazy adapters after grace when scope has zero live sessions", async () => {
    const dir = await makeTempDir("acb-age101-release-");
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
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "lazy-bot" });
    await storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([
      scopeKey(CLAUDE, reg.project, null),
    ]);
    const state = { zeroLiveSince: new Map<string, number>() };
    const now = { t: 5_000 };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => now.t,
    });

    const counts0 = await reconcileLazyAdapterScopes({
      storage,
      bus,
      bridges: [],
      factories: [factory],
      activeScopes,
      leaseArbiter,
      sessionOwnerIsLive: () => false,
      removeAdapter: removeLiveAdapter,
      state,
      graceMs: DEFAULT_SCOPE_RELEASE_GRACE_MS,
      now: () => now.t,
    });
    assert.equal(counts0.adapters_removed, 0);
    assert.equal(bus.listComms().length, 1);

    now.t += DEFAULT_SCOPE_RELEASE_GRACE_MS;
    const counts1 = await reconcileLazyAdapterScopes({
      storage,
      bus,
      bridges: [],
      factories: [factory],
      activeScopes,
      leaseArbiter,
      sessionOwnerIsLive: () => false,
      removeAdapter: removeLiveAdapter,
      state,
      graceMs: DEFAULT_SCOPE_RELEASE_GRACE_MS,
      now: () => now.t,
    });
    assert.equal(counts1.adapters_removed, 1);
    assert.equal(bus.listComms().length, 0);
    assert.equal(activeScopes.size, 0);

    await storage.close();
  });

  it("does NOT release eager registration at zero live sessions (AGE-97)", async () => {
    const dir = await makeTempDir("acb-age101-eager-");
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
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "eager-bot", activation: "eager" });
    await storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const state = { zeroLiveSince: new Map<string, number>() };
    const now = { t: 5_000 };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => now.t,
    });

    // First call records zeroLiveSince (grace not yet elapsed).
    await reconcileLazyAdapterScopes({
      storage,
      bus,
      bridges: [],
      factories: [factory],
      activeScopes,
      leaseArbiter,
      sessionOwnerIsLive: () => false,
      removeAdapter: removeLiveAdapter,
      state,
      graceMs: DEFAULT_SCOPE_RELEASE_GRACE_MS,
      now: () => now.t,
    });
    // After grace the release path IS reached — the eager-skip must protect it.
    now.t += DEFAULT_SCOPE_RELEASE_GRACE_MS;
    const counts = await reconcileLazyAdapterScopes({
      storage,
      bus,
      bridges: [],
      factories: [factory],
      activeScopes,
      leaseArbiter,
      sessionOwnerIsLive: () => false,
      removeAdapter: removeLiveAdapter,
      state,
      graceMs: DEFAULT_SCOPE_RELEASE_GRACE_MS,
      now: () => now.t,
    });
    assert.equal(counts.adapters_removed, 0, "eager adapter must NOT be released");
    assert.equal(bus.listComms().length, 1, "eager adapter stays live at zero sessions");

    await storage.close();
  });

  it("runSessionEndSweep reconciles via extended sweep without explicit exit hint", async () => {
    const dir = await makeTempDir("acb-age101-sweep-");
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
    const factory = new RecordingFactory();
    const reg = registration({ bot_user_id: "sweep-bot" });
    await storage.putAccountRegistration(reg);
    const adapter = factory.create({}, reg.bot_user_id as AccountId);
    bus.registerComm(adapter);
    await adapter.start();

    const activeScopes = new Set([scopeKey(CLAUDE, reg.project, null)]);
    const reconcileState = { zeroLiveSince: new Map<string, number>() };
    const now = { t: 1_000 };
    const leaseArbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => now.t,
    });

    reconcileState.zeroLiveSince.set(scopeKey(CLAUDE, reg.project, null), 0);
    now.t = DEFAULT_SCOPE_RELEASE_GRACE_MS + 1;

    const counts = await runSessionEndSweep({
      storage,
      now: () => now.t,
      isPidAlive: () => false,
      reconcile: {
        storage,
        bus,
        bridges: [],
        factories: [factory],
        activeScopes,
        leaseArbiter,
        sessionOwnerIsLive: () => false,
        removeAdapter: removeLiveAdapter,
        state: reconcileState,
        graceMs: DEFAULT_SCOPE_RELEASE_GRACE_MS,
      },
    });

    assert.ok(counts.reconcile);
    assert.equal(counts.reconcile.adapters_removed, 1);
    assert.equal(bus.listComms().length, 0);

    await storage.close();
  });
});

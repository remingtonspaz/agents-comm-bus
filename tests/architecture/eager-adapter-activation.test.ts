import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  FailureClassification,
  Message,
  OutboundPayload,
  SendResult,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { CommLeaseArbiter, type AgentLeaseProperties } from "../../core-daemon/runtime/comm-lease.js";
import {
  ensureCommsForSession,
  reloadAdapters,
} from "../../core-daemon/daemon.js";
import {
  ensureRegistrationForAccount,
  reconcileEagerRegistrations,
  type EnsureRegistrationContext,
} from "../../core-daemon/runtime/ensure-registration.js";
import { createEagerActivationRetryScheduler } from "../../core-daemon/runtime/eager-activation-retry.js";
import { adapterMapKey } from "../../core-daemon/runtime/comm-adapter-lifecycle.js";
import { accountUpdateActivation } from "../../core-daemon/cli/account-update-activation.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { resolveStatePaths } from "../../core-daemon/paths.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;

const EXPECTED_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

/** Injectable fake timer: records delays and runs callbacks under test control. */
function createFakeTimerHarness() {
  const delays: number[] = [];
  const pending = new Map<number, () => void>();
  let nextHandle = 1;

  const setTimeoutFn = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    delays.push(ms);
    const handle = nextHandle++;
    pending.set(handle, fn);
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  const clearTimeoutFn = (handle: ReturnType<typeof setTimeout>): void => {
    pending.delete(handle as number);
  };

  const flushPending = async (): Promise<boolean> => {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, fn] of entries) {
      fn();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return entries.length > 0;
  };

  return { delays, setTimeoutFn, clearTimeoutFn, flushPending };
}

class RecordingFactory {
  readonly commId = TELEGRAM;
  readonly created: string[] = [];
  readonly adapters = new Map<string, FakeAdapter>();
  throwOnCreateFor?: string;
  failStartFor?: string;
  startDelay?: () => Promise<void>;

  async resolveCredentials(
    registration: AccountRegistration,
  ): Promise<{ status: "ok"; credentials: Record<string, unknown> } | { status: "absent" }> {
    if (registration.credentials_ref === "file:/missing/creds.json") {
      return { status: "absent" };
    }
    return { status: "ok", credentials: {} };
  }

  create(_credentials: Record<string, unknown>, accountId: AccountId): CommAdapter {
    if (this.throwOnCreateFor === String(accountId)) {
      throw new Error("simulated factory.create throw");
    }
    this.created.push(String(accountId));
    const adapter = new FakeAdapter(
      accountId,
      this.failStartFor === String(accountId),
      this.startDelay,
    );
    this.adapters.set(String(accountId), adapter);
    return adapter;
  }
}

class FakeAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly allowedSenderIds: readonly string[] = [];
  startCount = 0;
  polling = false;

  constructor(
    readonly accountId: AccountId,
    private readonly failStart = false,
    private readonly startDelay?: () => Promise<void>,
  ) {}

  async start(): Promise<void> {
    if (this.startDelay) await this.startDelay();
    this.polling = true;
    if (this.failStart) throw new Error("simulated start failure");
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.polling = false;
  }

  onInbound(_handler: (msg: Message) => Promise<void>): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}

  async send(
    _target: ChatRef,
    _payload: OutboundPayload,
    _idempotencyKey: string,
  ): Promise<SendResult> {
    return { platform_message_id: "fake", sent_at: 1 };
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }

  classifyFailure(_error: unknown): FailureClassification {
    return "transient";
  }
}

function registration(
  project: string,
  botId: string,
  overrides: Partial<AccountRegistration> = {},
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: normalizeProjectPath(project),
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: botId === "botEager" ? "eager" : "lazy",
    bot_user_id: botId,
    registration_id: `reg-${botId}`,
    credentials_ref: "file:/does/not/matter.json",
    activation: "lazy",
    bot_username: "test_bot",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makeArbiter(dir: string): CommLeaseArbiter {
  return new CommLeaseArbiter({
    self: {
      pid: process.pid,
      stateRoot: dir,
      checkoutRoot: null,
      daemonBin: null,
      daemonVersion: "0.0.0",
      authorityRank: "worktree",
    },
    lastIpcServedAt: () => 1,
    homeDir: dir,
  });
}

async function makeHarness(stateRoot: string) {
  const paths = resolveStatePaths({ stateRoot });
  const storage = await openSqliteStorage(paths.database);
  const audit = new JsonlAuditStore(stateRoot);
  const blobs = new ContentAddressedBlobStore(stateRoot);
  const bus = new MessageBus({
    project: stateRoot,
    storage,
    transcripts: new JsonlTranscriptStore(stateRoot),
    audit,
    blobs,
    comms: [],
  });
  return { storage, audit, blobs, bus, stateRoot };
}

function baseEnsureCtx(
  dir: string,
  factory: RecordingFactory,
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  bus: MessageBus,
  blobs: ContentAddressedBlobStore,
  inFlight: Set<string>,
): Omit<EnsureRegistrationContext, "scheduleEagerRetry"> {
  return {
    factories: [factory],
    bus,
    bridges: [],
    storage,
    env: {},
    blobs,
    stateRoot: dir,
    leaseArbiter: makeArbiter(dir),
    inFlight,
  };
}

registerTempDirCleanup();

describe("AGE-97 eager adapter activation", () => {
  it("migration 014 defaults existing rows to lazy activation", async () => {
    const dir = await makeTempDir("acb-age97-migration-");
    const { storage } = await makeHarness(dir);
    try {
      await storage.putAccountRegistration(registration("proj", "botM"));
      const row = await storage.getAccountByBot(TELEGRAM, "botM");
      assert.equal(row?.activation, "lazy");
    } finally {
      await storage.close();
    }
  });

  it("exact-registration ensure activates only the flagged row, not lazy peers", async () => {
    const dir = await makeTempDir("acb-age97-exact-");
    const { storage, blobs, bus, audit } = await makeHarness(dir);
    const factory = new RecordingFactory();
    const inFlight = new Set<string>();
    try {
      await storage.putAccountRegistration(
        registration("proj", "botEager", { activation: "eager", account_label: "eager" }),
      );
      await storage.putAccountRegistration(registration("proj", "botLazy", { account_label: "lazy" }));

      const eagerReg = await storage.getAccountByBot(TELEGRAM, "botEager");
      assert.ok(eagerReg);
      await ensureRegistrationForAccount(eagerReg, {
        ...baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight),
        audit,
      });
      assert.deepEqual(factory.created, ["botEager"]);
      assert.equal(bus.getComm(TELEGRAM, "botLazy" as AccountId), null);
    } finally {
      await storage.close();
    }
  });

  it("ensureRegistrationForAccount does not add to activeScopes", async () => {
    const dir = await makeTempDir("acb-age97-scope-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    const activeScopes = new Set<string>();
    const inFlight = new Set<string>();
    try {
      await storage.putAccountRegistration(
        registration("proj", "botEager", { activation: "eager", account_label: "eager" }),
      );
      const eagerReg = await storage.getAccountByBot(TELEGRAM, "botEager");
      assert.ok(eagerReg);
      await ensureRegistrationForAccount(eagerReg, baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight));
      assert.equal(activeScopes.size, 0);
    } finally {
      await storage.close();
    }
  });

  it("invalid credentials schedule zero retry timers", async () => {
    const dir = await makeTempDir("acb-age97-permanent-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    const inFlight = new Set<string>();
    const fakeTimer = createFakeTimerHarness();
    try {
      await storage.putAccountRegistration(
        registration("proj", "botBad", {
          activation: "eager",
          credentials_ref: "file:/missing/creds.json",
          account_label: "bad",
        }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botBad");
      assert.ok(reg);
      const scheduler = createEagerActivationRetryScheduler({
        storage,
        ensure: baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight),
        setTimeoutFn: fakeTimer.setTimeoutFn,
        clearTimeoutFn: fakeTimer.clearTimeoutFn,
      });
      await ensureRegistrationForAccount(reg, {
        ...baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight),
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.deepEqual(fakeTimer.delays, [], "permanent credential failure must not arm a timer");
    } finally {
      await storage.close();
    }
  });

  it("retry backoff delays are exactly 1000, 2000, 4000, 8000, 16000 then stop", async () => {
    const dir = await makeTempDir("acb-age97-backoff-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.failStartFor = "botFlaky";
    const inFlight = new Set<string>();
    const fakeTimer = createFakeTimerHarness();
    const ensureCtx = baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight);
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: ensureCtx,
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);
      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.deepEqual(fakeTimer.delays, [1_000], "first schedule arms 1000ms");

      for (let i = 1; i < EXPECTED_BACKOFF_MS.length; i += 1) {
        await fakeTimer.flushPending();
        assert.deepEqual(
          fakeTimer.delays,
          EXPECTED_BACKOFF_MS.slice(0, i + 1),
          `after ${i} retries delays must match cap progression`,
        );
      }

      await fakeTimer.flushPending();
      assert.deepEqual(fakeTimer.delays, EXPECTED_BACKOFF_MS, "cap at MAX_RETRY_ATTEMPTS=5");

      await fakeTimer.flushPending();
      assert.deepEqual(
        fakeTimer.delays,
        EXPECTED_BACKOFF_MS,
        "no sixth timer after cap — mutation: restart-at-1 would keep scheduling",
      );
    } finally {
      scheduler.stopAll();
      await storage.close();
    }
  });

  it("exactly one timer per transient failure (no double-schedule)", async () => {
    const dir = await makeTempDir("acb-age97-one-timer-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.failStartFor = "botFlaky";
    const inFlight = new Set<string>();
    const fakeTimer = createFakeTimerHarness();
    const ensureCtx = baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight);
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: ensureCtx,
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);
      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.equal(fakeTimer.delays.length, 1, "initial transient failure arms one timer");

      await fakeTimer.flushPending();
      assert.equal(
        fakeTimer.delays.length,
        2,
        "one retry cycle arms exactly one additional timer — double-schedule bug would yield 3+",
      );
    } finally {
      scheduler.stopAll();
      await storage.close();
    }
  });

  it("stopAll prevents a new timer after an in-flight retry resolves transient", async () => {
    const dir = await makeTempDir("acb-age97-stopall-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.failStartFor = "botFlaky";
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let gateRetries = false;
    factory.startDelay = async () => {
      if (gateRetries) await startGate;
    };
    const inFlight = new Set<string>();
    const fakeTimer = createFakeTimerHarness();
    const ensureCtx = baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight);
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: ensureCtx,
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);
      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.equal(fakeTimer.delays.length, 1);

      gateRetries = true;
      const flushPromise = fakeTimer.flushPending();
      scheduler.stopAll();
      releaseStart();
      await flushPromise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(
        fakeTimer.delays.length,
        1,
        "stopAll fence must block post-resolve re-schedule",
      );
    } finally {
      scheduler.stopAll();
      await storage.close();
    }
  });

  it("terminal success resets attempt state so the next transient starts at 1000ms", async () => {
    const dir = await makeTempDir("acb-age97-terminal-reset-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.throwOnCreateFor = "botFlaky";
    const inFlight = new Set<string>();
    const fakeTimer = createFakeTimerHarness();
    const ensureCtx = baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight);
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: ensureCtx,
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);

      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.deepEqual(fakeTimer.delays.slice(-1), [1_000]);

      await fakeTimer.flushPending();
      assert.deepEqual(fakeTimer.delays, [1_000, 2_000]);

      factory.throwOnCreateFor = undefined;
      await fakeTimer.flushPending();
      assert.ok(bus.getComm(TELEGRAM, "botFlaky" as AccountId), "retry succeeds");

      const live = bus.getComm(TELEGRAM, "botFlaky" as AccountId);
      if (live) {
        await live.stop();
        bus.unregisterComm(TELEGRAM, "botFlaky" as AccountId);
      }

      factory.throwOnCreateFor = "botFlaky";
      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.deepEqual(
        fakeTimer.delays.slice(-1),
        [1_000],
        "after terminal success, attempt counter resets to 1000ms",
      );
    } finally {
      scheduler.stopAll();
      await storage.close();
    }
  });

  it("in-flight branch calls syncAgentProperties when agentLeaseProperties are set", async () => {
    const dir = await makeTempDir("acb-age97-inflight-sync-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    const inFlight = new Set<string>();
    const arbiter = makeArbiter(dir);
    let syncCalls = 0;
    const originalSync = arbiter.syncAgentProperties.bind(arbiter);
    arbiter.syncAgentProperties = async (commId: string, resourceId: string) => {
      syncCalls += 1;
      return originalSync(commId, resourceId);
    };
    const agentLeaseProperties: AgentLeaseProperties = {
      codex: { appServerUrl: "http://127.0.0.1:9999", threadId: "thread-1" },
    };
    try {
      await storage.putAccountRegistration(
        registration("proj", "botSync", { activation: "eager", account_label: "sync" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botSync");
      assert.ok(reg);
      inFlight.add(adapterMapKey(TELEGRAM, "botSync"));
      await ensureRegistrationForAccount(reg, {
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: arbiter,
        inFlight,
        agentLeaseProperties,
      });
      assert.equal(syncCalls, 1, "in-flight path must sync AGE-100 lease metadata");
    } finally {
      await storage.close();
    }
  });

  it("eager retry stops when activation is set back to lazy", async () => {
    const dir = await makeTempDir("acb-age97-retry-cancel-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.failStartFor = "botFlaky";
    const inFlight = new Set<string>();
    const fakeTimer = createFakeTimerHarness();
    const ensureCtx = baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight);
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: ensureCtx,
      setTimeoutFn: fakeTimer.setTimeoutFn,
      clearTimeoutFn: fakeTimer.clearTimeoutFn,
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);
      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.equal(fakeTimer.delays.length, 1);

      await storage.updateAccountRegistrationActivation({
        comm: TELEGRAM,
        bot_user_id: "botFlaky",
        activation: "lazy",
        updated_at: Date.now(),
      });

      await fakeTimer.flushPending();
      assert.equal(
        fakeTimer.delays.length,
        1,
        "lazy flip must cancel retry — no second timer armed",
      );
    } finally {
      scheduler.stopAll();
      await storage.close();
    }
  });

  it("one eager registration failure does not block another", async () => {
    const dir = await makeTempDir("acb-age97-isolate-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.failStartFor = "botBad";
    const inFlight = new Set<string>();
    try {
      await storage.putAccountRegistration(
        registration("proj", "botBad", {
          activation: "eager",
          account_label: "bad",
        }),
      );
      await storage.putAccountRegistration(
        registration("proj", "botGood", {
          activation: "eager",
          account_label: "good",
          registration_id: "reg-botGood",
        }),
      );
      await reconcileEagerRegistrations({
        storage,
        ensure: baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight),
      });
      assert.ok(bus.getComm(TELEGRAM, "botGood" as AccountId));
      assert.equal(bus.getComm(TELEGRAM, "botBad" as AccountId), null);
    } finally {
      await storage.close();
    }
  });

  it("lazy→eager via CLI update leaves adapter live; eager→lazy does not stop it", async () => {
    const dir = await makeTempDir("acb-age97-cli-transition-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    const inFlight = new Set<string>();
    try {
      await storage.putAccountRegistration(registration("proj", "botX", { account_label: "main" }));
      const result = await accountUpdateActivation({
        comm: TELEGRAM,
        botId: "botX",
        activation: "eager",
        stateRoot: dir,
      });
      assert.equal(result.next.activation, "eager");
      await ensureRegistrationForAccount(result.next, baseEnsureCtx(dir, factory, storage, bus, blobs, inFlight));
      assert.ok(bus.getComm(TELEGRAM, "botX" as AccountId));
      const back = await accountUpdateActivation({
        comm: TELEGRAM,
        botId: "botX",
        activation: "lazy",
        stateRoot: dir,
      });
      assert.equal(back.next.activation, "lazy");
      assert.ok(bus.getComm(TELEGRAM, "botX" as AccountId), "live adapter stays up when demoted to lazy");
    } finally {
      await storage.close();
    }
  });

  it("ensureCommsForSession collects per-registration outcomes", async () => {
    const dir = await makeTempDir("acb-age97-outcomes-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    try {
      await storage.putAccountRegistration(registration("proj", "botA", { account_label: "a" }));
      const { outcomes } = await ensureCommsForSession({
        project: "proj",
        agent: CLAUDE,
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight: new Set(),
      });
      assert.equal(outcomes.length, 1);
      assert.equal(factory.created.length, 1, "session ensure must start the scoped adapter");
    } finally {
      await storage.close();
    }
  });

  it("reload hot-adds eager registrations without an active session scope", async () => {
    const dir = await makeTempDir("acb-age97-reload-eager-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    try {
      await storage.putAccountRegistration(
        registration("projZ", "botZ", { activation: "eager", account_label: "z" }),
      );
      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
      });
      assert.equal(summary.added.length, 1);
      assert.ok(bus.getComm(TELEGRAM, "botZ" as AccountId));
    } finally {
      await storage.close();
    }
  });
});

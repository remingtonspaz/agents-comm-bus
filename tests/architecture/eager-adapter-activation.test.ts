import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  ConversationId,
  FailureClassification,
  Message,
  MessageId,
  OutboundPayload,
  SendResult,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import {
  ensureCommsForSession,
  reloadAdapters,
} from "../../core-daemon/daemon.js";
import {
  ensureRegistrationForAccount,
  reconcileEagerRegistrations,
} from "../../core-daemon/runtime/ensure-registration.js";
import {
  createEagerActivationRetryScheduler,
} from "../../core-daemon/runtime/eager-activation-retry.js";
import { accountUpdateActivation } from "../../core-daemon/cli/account-update-activation.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { resolveStatePaths } from "../../core-daemon/paths.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;

class RecordingFactory {
  readonly commId = TELEGRAM;
  readonly created: string[] = [];
  readonly adapters = new Map<string, FakeAdapter>();
  throwOnCreateFor?: string;
  failStartFor?: string;

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
    const adapter = new FakeAdapter(accountId, this.failStartFor === String(accountId));
    this.adapters.set(String(accountId), adapter);
    return adapter;
  }
}

class FakeAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly allowedSenderIds: readonly string[] = [];
  startCount = 0;
  polling = false;

  constructor(readonly accountId: AccountId, private readonly failStart = false) {}

  async start(): Promise<void> {
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
      const outcome = await ensureRegistrationForAccount(eagerReg, {
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight,
        audit,
      });
      assert.equal(outcome.status, "started");
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
      await ensureRegistrationForAccount(eagerReg, {
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight,
      });
      assert.equal(activeScopes.size, 0);
    } finally {
      await storage.close();
    }
  });

  it("invalid credentials are permanent and do not schedule eager retry", async () => {
    const dir = await makeTempDir("acb-age97-permanent-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    const inFlight = new Set<string>();
    let retryScheduled = false;
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
      const outcome = await ensureRegistrationForAccount(reg, {
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight,
        scheduleEagerRetry: () => {
          retryScheduled = true;
        },
      });
      assert.equal(outcome.status, "invalid-credentials");
      assert.equal(outcome.retryClass, "permanent");
      assert.equal(retryScheduled, false);
    } finally {
      await storage.close();
    }
  });

  it("transient construction failure schedules bounded eager retry", async () => {
    const dir = await makeTempDir("acb-age97-retry-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.throwOnCreateFor = "botFlaky";
    const inFlight = new Set<string>();
    const ensureCtx = {
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
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: {
        ...ensureCtx,
        scheduleEagerRetry: (id: string) => scheduler.schedule(id),
      },
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);
      const outcome = await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => scheduler.schedule(id),
      });
      assert.equal(outcome.status, "construction-failed");
      assert.equal(outcome.retryClass, "transient");
      assert.equal(factory.created.length, 0);
    } finally {
      scheduler.stopAll();
      await storage.close();
    }
  });

  it("eager retry stops when activation is set back to lazy", async () => {
    const dir = await makeTempDir("acb-age97-retry-cancel-");
    const { storage, blobs, bus } = await makeHarness(dir);
    const factory = new RecordingFactory();
    factory.failStartFor = "botFlaky";
    const inFlight = new Set<string>();
    let attempts = 0;
    const ensureCtx = {
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
    const scheduler = createEagerActivationRetryScheduler({
      storage,
      ensure: {
        ...ensureCtx,
        scheduleEagerRetry: (id: string) => scheduler.schedule(id),
      },
    });
    try {
      await storage.putAccountRegistration(
        registration("proj", "botFlaky", { activation: "eager", account_label: "flaky" }),
      );
      const reg = await storage.getAccountByBot(TELEGRAM, "botFlaky");
      assert.ok(reg);
      await ensureRegistrationForAccount(reg, {
        ...ensureCtx,
        scheduleEagerRetry: (id) => {
          attempts += 1;
          scheduler.schedule(id);
        },
      });
      await storage.updateAccountRegistrationActivation({
        comm: TELEGRAM,
        bot_user_id: "botFlaky",
        activation: "lazy",
        updated_at: Date.now(),
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal(attempts, 1, "retry must not re-fire after lazy flip");
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
        ensure: {
          factories: [factory],
          bus,
          bridges: [],
          storage,
          env: {},
          blobs,
          stateRoot: dir,
          leaseArbiter: makeArbiter(dir),
          inFlight,
        },
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
      await ensureRegistrationForAccount(result.next, {
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight,
      });
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

  it("ensureCommsForSession returns typed per-registration outcomes", async () => {
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
      assert.equal(outcomes[0].status, "started");
      assert.equal(outcomes[0].retryClass, "success");
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

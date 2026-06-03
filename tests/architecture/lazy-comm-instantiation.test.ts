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
  Session,
  SessionId,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_SESSION,
} from "../../packages/core-contracts/src/types.js";
import type { AgentBridge } from "../../core-daemon/runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import {
  addAdapterForRegistration,
  ensureCommsForSession,
  reloadAdapters,
} from "../../core-daemon/daemon.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;

// A comm factory that RECORDS which bots it constructs, so a test can assert
// that un-instantiated registrations are never even built (no construct → no
// start → no lease). Adapters declare no `exclusiveResource()`, so they are not
// lease-wrapped and no real lease file is written during the test.
class RecordingFactory {
  readonly commId = TELEGRAM;
  readonly created: string[] = [];
  readonly adapters = new Map<string, FakeAdapter>();
  failStartFor?: string;

  async resolveCredentials(): Promise<{ credentials: Record<string, unknown> }> {
    return { credentials: {} };
  }

  create(_credentials: Record<string, unknown>, accountId: AccountId): CommAdapter {
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
  stopCount = 0;

  constructor(readonly accountId: AccountId, private readonly failStart = false) {}

  async start(): Promise<void> {
    if (this.failStart) throw new Error("simulated start failure");
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
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

function registration(project: string, botId: string): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project,
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: botId,
    registration_id: `reg-${botId}`,
    credentials_ref: "file:/does/not/matter.json",
    bot_username: "test_bot",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
  };
}

function session(id: string, project: string): Session {
  return {
    schema_version: SCHEMA_VERSION_SESSION,
    session_id: id as SessionId,
    agent: CLAUDE,
    project,
    created_at: 1,
    lease_holder_connection_id: null,
    lease_acquired_at: null,
    lease_released_at: null,
    lease_owner_process_pid: null,
    lease_owner_process_label: null,
    lease_owner_process_registered_at: null,
    most_recent_inbound_conversation_id: null,
    status: "active",
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

async function makeHarness(dir: string) {
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  const transcripts = new JsonlTranscriptStore(dir);
  const audit = new JsonlAuditStore(dir);
  const blobs = new ContentAddressedBlobStore(dir);
  const bus = new MessageBus({ project: dir, storage, transcripts, audit, blobs, comms: [] });
  return { storage, transcripts, audit, blobs, bus };
}

registerTempDirCleanup();

describe("AGE-38 lazy, session-triggered comm-adapter instantiation", () => {
  it("instantiates ONLY the session's (project, agent) bots — never other projects'", async () => {
    const dir = await makeTempDir("acb-lazy-scope-");
    const { storage, blobs, bus } = await makeHarness(dir);
    try {
      await storage.putAccountRegistration(registration("projX", "botX"));
      await storage.putAccountRegistration(registration("projY", "botY"));
      const factory = new RecordingFactory();

      await ensureCommsForSession({
        project: "projX",
        agent: CLAUDE,
        factories: [factory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight: new Set<string>(),
      });

      assert.ok(bus.getComm(TELEGRAM, "botX" as AccountId), "project X's bot is live");
      assert.equal(
        bus.getComm(TELEGRAM, "botY" as AccountId),
        null,
        "project Y's bot must NOT be instantiated by a project-X session",
      );
      // Negative space: the other project's bot is never even constructed, so it
      // cannot have called start() or attempted a lease.
      assert.deepEqual(factory.created, ["botX"], "only project X's bot constructed");
      assert.equal(factory.adapters.get("botX")!.startCount, 1, "the scoped bot was started once");
    } finally {
      await storage.close();
    }
  });

  it("is idempotent — repeated registers do not double-instantiate", async () => {
    const dir = await makeTempDir("acb-lazy-idem-");
    const { storage, blobs, bus } = await makeHarness(dir);
    try {
      await storage.putAccountRegistration(registration("projX", "botX"));
      const factory = new RecordingFactory();
      const inFlight = new Set<string>();
      const call = () =>
        ensureCommsForSession({
          project: "projX",
          agent: CLAUDE,
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

      await call();
      await call(); // hooks register before every prompt — must be a no-op

      assert.deepEqual(factory.created, ["botX"], "constructed exactly once across repeated registers");
      assert.equal(factory.adapters.get("botX")!.startCount, 1);
    } finally {
      await storage.close();
    }
  });

  it("wires attachComm on every bridge for a lazily-added adapter", async () => {
    const dir = await makeTempDir("acb-lazy-attach-");
    const { storage, blobs, bus } = await makeHarness(dir);
    try {
      await storage.putAccountRegistration(registration("projX", "botX"));
      const factory = new RecordingFactory();
      const attached: string[] = [];
      // Minimal bridge stub: only attachComm is exercised by the add-sequence.
      const bridge = {
        attachComm: (comm: CommAdapter) => attached.push(String(comm.accountId)),
      } as unknown as AgentBridge;

      await ensureCommsForSession({
        project: "projX",
        agent: CLAUDE,
        factories: [factory],
        bus,
        bridges: [bridge],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight: new Set<string>(),
      });

      assert.deepEqual(
        attached,
        ["botX"],
        "attachComm must be called for the lazily-added adapter (wires button-tap callbacks)",
      );
    } finally {
      await storage.close();
    }
  });

  it("rolls back a failed start so the bot is not left wedged in the bus", async () => {
    const dir = await makeTempDir("acb-lazy-rollback-");
    const { storage, blobs, bus } = await makeHarness(dir);
    try {
      const factory = new RecordingFactory();
      factory.failStartFor = "botX";

      const result = await addAdapterForRegistration({
        factory,
        registration: registration("projX", "botX"),
        bus,
        bridges: [],
        env: {},
        blobs,
        stateRoot: dir,
        storage,
        leaseArbiter: makeArbiter(dir),
      });

      assert.equal(result.ok, false, "a failed start surfaces as not-ok, not a throw");
      assert.equal(
        bus.getComm(TELEGRAM, "botX" as AccountId),
        null,
        "the failed-to-start adapter must be rolled back out of the bus map",
      );

      // The bot is re-addable after rollback (it wasn't left wedged).
      factory.failStartFor = undefined;
      const retry = await addAdapterForRegistration({
        factory,
        registration: registration("projX", "botX"),
        bus,
        bridges: [],
        env: {},
        blobs,
        stateRoot: dir,
        storage,
        leaseArbiter: makeArbiter(dir),
      });
      assert.equal(retry.ok, true, "re-add after rollback succeeds");
      assert.ok(bus.getComm(TELEGRAM, "botX" as AccountId), "bot is live after a successful retry");
    } finally {
      await storage.close();
    }
  });

  it("reload never eager-adds an un-instantiated registration (req B: courtesy preserved)", async () => {
    const dir = await makeTempDir("acb-lazy-reload-");
    const { storage, blobs, bus } = await makeHarness(dir);
    try {
      const factory = new RecordingFactory();

      // botZ is LIVE (instantiated earlier via a session); botX only exists as a
      // DB row with no live session/adapter.
      const liveZ = factory.create({}, "botZ" as AccountId);
      bus.registerComm(liveZ);
      await storage.putAccountRegistration(registration("projZ", "botZ"));
      await storage.putAccountRegistration(registration("projX", "botX"));

      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: {} as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
      });

      assert.equal(
        bus.getComm(TELEGRAM, "botX" as AccountId),
        null,
        "an un-instantiated DB row must NOT be eager-added by reload (would undo courtesy)",
      );
      assert.equal(summary.added.length, 0, "reload adds nothing under lazy loading");
      assert.ok(bus.getComm(TELEGRAM, "botZ" as AccountId), "the already-live bot remains attached");
    } finally {
      await storage.close();
    }
  });

  it("drain is scoped to the session's project — does not sweep another project's inbound (req A)", async () => {
    const dir = await makeTempDir("acb-lazy-drain-");
    const { storage, blobs, bus, transcripts, audit } = await makeHarness(dir);
    try {
      await storage.putAccountRegistration(registration("projX", "botX"));
      await storage.putAccountRegistration(registration("projY", "botY"));
      await storage.upsertSession(session("sx", "projX"));
      await storage.upsertSession(session("sy", "projY"));

      const pendingInbound: PendingInboundEntry[] = [
        pendingEntry("1", "botX"),
        pendingEntry("2", "botY"),
        pendingEntry("3", "botX"),
      ];

      const bridge = new ClaudeBridge({ storage, bus, pendingInbound });
      // drainPendingInbound(session) applies the project-scoped owned-account
      // filter (the req-A behavior) without drainInbound's most-recent-inbound
      // write, which would need conversation rows that aren't relevant here.
      const drained = await bridge.drainPendingInbound("sx" as SessionId);

      assert.deepEqual(
        drained.map((e) => e.message.chat.account),
        ["botX", "botX"],
        "a project-X session drains only project X's bot inbound",
      );
      assert.deepEqual(
        pendingInbound.map((e) => e.message.chat.account),
        ["botY"],
        "project Y's inbound must survive a project-X drain",
      );
      void transcripts;
      void audit;
    } finally {
      await storage.close();
    }
  });
});

function pendingEntry(id: string, account: string): PendingInboundEntry {
  const message: Message = {
    schema_version: 1,
    message_id: `telegram:${id}` as MessageId,
    chat: {
      comm: TELEGRAM,
      account: account as AccountId,
      chat_native_id: "chat-1",
    },
    sender: {
      id: "user-1",
      display_name: "user-1",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm: TELEGRAM },
    text: `msg ${id}`,
    hop_count: 0,
    received_at: Number(id),
    platform_message_id: id,
  };
  return {
    message,
    conversation: {
      schema_version: 1,
      project: "p",
      comm: TELEGRAM,
      account_label: "main",
      bot_user_id: account,
      chat_native_id: "chat-1",
      thread_native_id: null,
      conversation_id: `conv-${id}` as ConversationId,
      agent: CLAUDE,
      last_inbound_at: Number(id),
      last_outbound_at: null,
      last_message_id: `telegram:${id}` as MessageId,
      created_at: Number(id),
    },
  };
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { MessageBus } from "../../core-daemon/bus.js";
import { PiBridge } from "../../core-daemon/bridges/pi/bridge.js";
import {
  DEFAULT_BOOT_RESTORE_RECENCY_MS,
  runBootScopeRestore,
} from "../../core-daemon/bootstrap/boot-scope-restore.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type { DaemonSelfIdentity, EnsureCommsForSession } from "../../core-daemon/runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  SessionId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/index.js";

registerTempDirCleanup();

const TELEGRAM = "telegram" as CommId;
const MATRIX = "matrix" as CommId;
const CLAUDE = "claude" as AgentId;
const CODEX = "codex" as AgentId;
const PI = "pi" as AgentId;
const PROJECT_A = normalizeProjectPath("D:/work/project-a");
const PROJECT_B = normalizeProjectPath("D:/work/project-b");
const PI_BOT = "pi-bot-1";
const CLAUDE_BOT = "claude-bot-1";
const CODEX_BOT = "codex-bot-1";
const NOW = 1_700_000_000_000;
const RECENT = NOW - 60_000;

const DAEMON_OWNER: DaemonSelfIdentity = {
  discoveryRoot: "C:\\Users\\me\\.agents-comm-bus",
  checkoutRoot: "C:\\work\\repo",
  stateRoot: "C:\\Users\\me\\.agents-comm-bus",
  daemonBin: "C:\\bin\\daemon.js",
  authorityRank: "production",
};

interface EnsureCall {
  project: string;
  agent: AgentId;
  leaseHeld: boolean;
}

function recordingEnsure(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  session: SessionId,
  connectionId: string,
): { fn: EnsureCommsForSession; calls: EnsureCall[] } {
  const calls: EnsureCall[] = [];
  const fn: EnsureCommsForSession = async (project, agent) => {
    const sess = await storage.getSession(session);
    calls.push({
      project,
      agent,
      leaseHeld: sess?.lease_holder_connection_id === connectionId,
    });
  };
  return { fn, calls };
}

function registration(
  agent: AgentId,
  botUserId: string,
  project = PROJECT_A,
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project,
    comm: TELEGRAM,
    agent,
    account_label: "main",
    registration_id: `reg-${agent}-${botUserId}`,
    bot_user_id: botUserId,
    credentials_ref: "file:/dev/null",
    created_at: 1,
    updated_at: 1,
  };
}

function conversation(
  agent: AgentId,
  botUserId: string,
  conversationId: ConversationId,
  project = PROJECT_A,
  comm: CommId = TELEGRAM,
): Conversation {
  return {
    schema_version: 1,
    project,
    agent,
    comm,
    account_label: "main",
    bot_user_id: botUserId,
    registration_id: `reg-${agent}-${botUserId}`,
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: conversationId,
    last_inbound_at: 1000,
    last_outbound_at: null,
    last_message_id: "telegram:1" as MessageId,
    created_at: 1000,
  };
}

function message(
  botUserId: string,
  comm: CommId,
  id: string,
): Message {
  return {
    schema_version: 1,
    message_id: `${comm}:${id}` as MessageId,
    chat: {
      comm,
      account: botUserId as AccountId,
      chat_native_id: "chat-1",
    },
    sender: {
      id: "user-1",
      display_name: "User",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm },
    text: `msg ${id}`,
    hop_count: 0,
    received_at: Number(id),
    platform_message_id: id,
  };
}

function pendingEntry(
  agent: AgentId,
  botUserId: string,
  id: string,
  comm: CommId = TELEGRAM,
  project = PROJECT_A,
): PendingInboundEntry {
  const conversationId = `conv-${agent}-${comm}-${id}` as ConversationId;
  const chatNativeId = `chat-${id}`;
  const conv = conversation(agent, botUserId, conversationId, project, comm);
  conv.chat_native_id = chatNativeId;
  return {
    message: {
      ...message(botUserId, comm, id),
      chat: {
        comm,
        account: botUserId as AccountId,
        chat_native_id: chatNativeId,
      },
    },
    conversation: conv,
  };
}

class FakeSocket {
  private closeHandler: (() => void) | null = null;

  once(event: "close", handler: () => void): void {
    if (event === "close") this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
  }
}

class RecordingCommAdapter {
  readonly id = TELEGRAM;
  readonly accountId = PI_BOT as AccountId;
  lastTarget: { chat_native_id: string; account: string } | null = null;

  onInbound(_handler: (message: Message) => Promise<unknown> | unknown): void {}
  onConnectionState(_handler: (state: "connecting" | "connected" | "degraded" | "disconnected") => void): void {}
  classifyFailure(): { retryable: boolean; reason: string } {
    return { retryable: false, reason: "test" };
  }
  reportPressure(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(
    target: { chat_native_id: string; account: string },
    _payload: unknown,
    _idempotencyKey: string,
  ): Promise<{ platform_message_id: string; sent_at: number }> {
    this.lastTarget = target;
    return { platform_message_id: "out-1", sent_at: 2000 };
  }
}

async function seedConversations(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  entries: PendingInboundEntry[],
): Promise<void> {
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = entry.conversation.conversation_id;
    if (seen.has(id)) continue;
    seen.add(id);
    await storage.upsertConversation(entry.conversation);
  }
}

async function withStorage<T>(
  test: (ctx: {
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
    dir: string;
  }) => Promise<T>,
): Promise<T> {
  const dir = await makeTempDir("acb-pi-bridge-");
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  try {
    return await test({ storage, dir });
  } finally {
    await storage.close();
  }
}

describe("AGE-59 Pi bridge registration", () => {
  it("pi_register_session calls ensureCommsForSession(project, pi) after lease acquire", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_s1" as SessionId;
      const connectionId = "pi:runtime-1";
      const { fn: ensureCommsForSession, calls } = recordingEnsure(storage, session, connectionId);
      const bridge = new PiBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        ensureCommsForSession,
        daemonOwner: DAEMON_OWNER,
      });

      const result = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
        host: { pid: process.pid, label: "pi-tui" },
      });

      assert.equal(result.ok, true);
      assert.equal(result.agent, "pi");
      assert.deepEqual(calls, [{ project: PROJECT_A, agent: "pi", leaseHeld: true }]);
    });
  });

  it("upserts session row with agent = pi", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_s2" as SessionId;
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: "pi:runtime-2",
      });
      const row = await storage.getSession(session);
      assert.equal(row?.agent, "pi");
      assert.equal(row?.project, PROJECT_A);
    });
  });

  it("repeated registration with same connection_id is idempotent", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_s3" as SessionId;
      const connectionId = "pi:runtime-3";
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      const first = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
      });
      const second = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      const rows = await storage.listSessions({ agent: "pi" });
      assert.equal(rows.length, 1);
    });
  });

  it("missing connection_id throws", async () => {
    await withStorage(async ({ storage }) => {
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await assert.rejects(
        () => bridge.registerSession({ session: "pi_s4", project: PROJECT_A }),
        /connection_id is required/,
      );
    });
  });

  it("stamps daemon-owner identity on lease acquire (AGE-58)", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_s5" as SessionId;
      const bridge = new PiBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        daemonOwner: DAEMON_OWNER,
      });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: "pi:runtime-5",
        host: { pid: process.pid, label: "pi" },
      });
      const row = await storage.getSession(session);
      assert.equal(row?.lease_owner_daemon_discovery_root, DAEMON_OWNER.discoveryRoot);
      assert.equal(row?.lease_owner_daemon_checkout_root, DAEMON_OWNER.checkoutRoot);
      assert.equal(row?.lease_owner_daemon_state_root, DAEMON_OWNER.stateRoot);
      assert.equal(row?.lease_owner_daemon_bin, DAEMON_OWNER.daemonBin);
      assert.equal(row?.lease_owner_daemon_authority_rank, DAEMON_OWNER.authorityRank);
    });
  });

  it("missing or invalid session/project fail loudly", async () => {
    await withStorage(async ({ storage }) => {
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await assert.rejects(
        () => bridge.registerSession({ project: PROJECT_A, connection_id: "pi:x" }),
        /session is required/,
      );
      await assert.rejects(
        () => bridge.registerSession({ session: "pi_s6", connection_id: "pi:x" }),
        /project is required/,
      );
    });
  });
});

describe("AGE-59 Pi bridge drain", () => {
  it("returns only Pi-scoped entries", async () => {
    await withStorage(async ({ storage }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      await storage.putAccountRegistration(registration(CLAUDE, CLAUDE_BOT));
      const session = "pi_drain_1" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });

      const pendingInbound: PendingInboundEntry[] = [
        pendingEntry(PI, PI_BOT, "1"),
        pendingEntry(CLAUDE, CLAUDE_BOT, "2"),
        pendingEntry(PI, PI_BOT, "3"),
      ];
      await seedConversations(storage, pendingInbound);
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound });
      const { messages } = await bridge.drainInbound({ session });
      assert.deepEqual(messages.map((e) => e.message.platform_message_id), ["1", "3"]);
      assert.deepEqual(
        pendingInbound.map((e) => e.message.platform_message_id),
        ["2"],
      );
    });
  });

  it("does not cannibalize Claude or Codex pending inbound", async () => {
    await withStorage(async ({ storage }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      await storage.putAccountRegistration(registration(CLAUDE, CLAUDE_BOT));
      await storage.putAccountRegistration(registration(CODEX, CODEX_BOT));
      const session = "pi_drain_2" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });

      const pendingInbound: PendingInboundEntry[] = [
        pendingEntry(CLAUDE, CLAUDE_BOT, "c1"),
        pendingEntry(CODEX, CODEX_BOT, "x1"),
        pendingEntry(PI, PI_BOT, "p1"),
      ];
      await seedConversations(storage, pendingInbound);
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound });
      await bridge.drainInbound({ session });
      assert.deepEqual(
        pendingInbound.map((e) => e.message.platform_message_id),
        ["c1", "x1"],
      );
    });
  });

  it("honors limit", async () => {
    await withStorage(async ({ storage }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      const session = "pi_drain_3" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });
      const pendingInbound: PendingInboundEntry[] = [
        pendingEntry(PI, PI_BOT, "1"),
        pendingEntry(PI, PI_BOT, "2"),
        pendingEntry(PI, PI_BOT, "3"),
      ];
      await seedConversations(storage, pendingInbound);
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound });
      const { messages } = await bridge.drainInbound({ session, limit: 2 });
      assert.deepEqual(messages.map((e) => e.message.platform_message_id), ["1", "2"]);
      assert.equal(pendingInbound.length, 1);
      assert.equal(pendingInbound[0].message.platform_message_id, "3");
    });
  });

  it("honors comm filter; non-matching comms stay queued", async () => {
    await withStorage(async ({ storage }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      await storage.putAccountRegistration({
        ...registration(PI, PI_BOT),
        comm: MATRIX,
        registration_id: "reg-pi-matrix",
      });
      const session = "pi_drain_4" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });
      const pendingInbound: PendingInboundEntry[] = [
        pendingEntry(PI, PI_BOT, "t1", TELEGRAM),
        pendingEntry(PI, PI_BOT, "m1", MATRIX),
        pendingEntry(PI, PI_BOT, "t2", TELEGRAM),
      ];
      await seedConversations(storage, pendingInbound);
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound });
      const { messages } = await bridge.drainInbound({ session, comm: "telegram" });
      assert.deepEqual(messages.map((e) => e.message.platform_message_id), ["t1", "t2"]);
      assert.deepEqual(
        pendingInbound.map((e) => e.message.platform_message_id),
        ["m1"],
      );
    });
  });

  it("removes by (message_id, comm, account) composite key", async () => {
    await withStorage(async ({ storage }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      await storage.putAccountRegistration(registration(CLAUDE, CLAUDE_BOT));
      const session = "pi_drain_5" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });

      const sharedId = "shared-msg";
      const piEntry = pendingEntry(PI, PI_BOT, sharedId);
      const claudeEntry = pendingEntry(CLAUDE, CLAUDE_BOT, sharedId);
      const pendingInbound: PendingInboundEntry[] = [piEntry, claudeEntry];
      await seedConversations(storage, pendingInbound);
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound });
      await bridge.drainInbound({ session });
      assert.equal(pendingInbound.length, 1);
      assert.equal(pendingInbound[0].message.chat.account, CLAUDE_BOT);
    });
  });

  it("stamps most_recent_inbound to last drained conversation", async () => {
    await withStorage(async ({ storage }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      const session = "pi_drain_6" as SessionId;
      const conv1 = "conv-pi-1" as ConversationId;
      const conv2 = "conv-pi-2" as ConversationId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });
      const pendingInbound: PendingInboundEntry[] = [
        {
          ...pendingEntry(PI, PI_BOT, "1"),
          conversation: { ...conversation(PI, PI_BOT, conv1), chat_native_id: "chat-1" },
        },
        {
          ...pendingEntry(PI, PI_BOT, "2"),
          conversation: { ...conversation(PI, PI_BOT, conv2), chat_native_id: "chat-2" },
        },
      ];
      pendingInbound[0].message.chat.chat_native_id = "chat-1";
      pendingInbound[1].message.chat.chat_native_id = "chat-2";
      await seedConversations(storage, pendingInbound);
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound });
      await bridge.drainInbound({ session });
      const row = await storage.getSession(session);
      assert.equal(row?.most_recent_inbound_conversation_id, conv2);
    });
  });

  it("no-target send routes to drained conversation via bus.targetFromSession", async () => {
    await withStorage(async ({ storage, dir }) => {
      await storage.putAccountRegistration(registration(PI, PI_BOT));
      const convId = "conv-pi-send" as ConversationId;
      await storage.upsertConversation(conversation(PI, PI_BOT, convId));
      const session = "pi_drain_7" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });

      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const bus = new MessageBus({
        project: PROJECT_A,
        storage,
        transcripts,
        audit,
        now: () => 2000,
      });
      const adapter = new RecordingCommAdapter();
      bus.registerComm(adapter as never);

      const pendingInbound: PendingInboundEntry[] = [
        {
          ...pendingEntry(PI, PI_BOT, "1"),
          conversation: { ...conversation(PI, PI_BOT, convId), chat_native_id: "chat-1" },
        },
      ];
      pendingInbound[0].message.chat.chat_native_id = "chat-1";
      const bridge = new PiBridge({ storage, bus, pendingInbound });
      await bridge.drainInbound({ session });

      await bus.send({
        comm: TELEGRAM,
        session,
        payload: { format: "plain", text: "reply" },
      });

      assert.equal(adapter.lastTarget?.account, PI_BOT);
      assert.equal(adapter.lastTarget?.chat_native_id, "chat-1");
    });
  });

  it("rejects drain when caller project mismatches stored session row", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_drain_8" as SessionId;
      await storage.upsertSession({
        schema_version: 1,
        session_id: session,
        agent: PI,
        project: PROJECT_A,
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
        status: "active",
      });
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await assert.rejects(
        () => bridge.drainInbound({ session, project: PROJECT_B }),
        /project mismatch/,
      );
    });
  });

  it("returns empty messages when session row is missing", async () => {
    await withStorage(async ({ storage }) => {
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      const { messages } = await bridge.drainInbound({ session: "pi_missing" as SessionId });
      assert.deepEqual(messages, []);
    });
  });
});

describe("AGE-59 Pi bridge unregister", () => {
  it("ends the session with the same stable connection_id used at register", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_unreg_1" as SessionId;
      const connectionId = "pi:runtime-unreg";
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
        host: { pid: process.pid, label: "pi" },
      });
      const during = await storage.getSession(session);
      assert.equal(during?.lease_holder_connection_id, connectionId);

      await bridge.unregisterSession({ session, connection_id: connectionId });
      const after = await storage.getSession(session);
      assert.equal(after?.status, "ended");
      assert.equal(after?.lease_holder_connection_id, null);
      assert.notEqual(after?.lease_released_at, null);
      assert.equal(after?.lease_owner_process_pid, process.pid);
      assert.equal(after?.lease_owner_process_label, "pi");
    });
  });

  it("is idempotent on already-released session", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_unreg_2" as SessionId;
      const connectionId = "pi:runtime-unreg-2";
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
      });
      await bridge.unregisterSession({ session, connection_id: connectionId });
      await assert.doesNotReject(() =>
        bridge.unregisterSession({ session, connection_id: connectionId }),
      );
    });
  });

  it("does not release a different session lease", async () => {
    await withStorage(async ({ storage }) => {
      const sessionA = "pi_unreg_a" as SessionId;
      const sessionB = "pi_unreg_b" as SessionId;
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({
        session: sessionA,
        project: PROJECT_A,
        connection_id: "pi:conn-a",
      });
      await bridge.registerSession({
        session: sessionB,
        project: PROJECT_A,
        connection_id: "pi:conn-b",
      });
      await bridge.unregisterSession({
        session: sessionA,
        connection_id: "pi:conn-wrong",
      });
      const rowA = await storage.getSession(sessionA);
      assert.equal(rowA?.lease_holder_connection_id, "pi:conn-a");
    });
  });

  it("fresh register after unregister re-acquires cleanly", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_unreg_3" as SessionId;
      const connectionId = "pi:runtime-cycle";
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({ session, project: PROJECT_A, connection_id: connectionId });
      await bridge.unregisterSession({ session, connection_id: connectionId });
      const replay = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
      });
      assert.equal(replay.ok, true);
      const row = await storage.getSession(session);
      assert.equal(row?.lease_holder_connection_id, connectionId);
    });
  });

  it("rejects unregister when caller project mismatches stored row", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_unreg_4" as SessionId;
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: "pi:conn-4",
      });
      await assert.rejects(
        () => bridge.unregisterSession({
          session,
          project: PROJECT_B,
          connection_id: "pi:conn-4",
        }),
        /project mismatch/,
      );
    });
  });

  it("after unregister boot-scope-restore does not restore ended scope", async () => {
    await withStorage(async ({ storage, dir }) => {
      const session = "pi_unreg_5" as SessionId;
      const connectionId = "pi:runtime-boot";
      const bridge = new PiBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        daemonOwner: DAEMON_OWNER,
      });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
        host: { pid: process.pid, label: "pi" },
      });
      await bridge.unregisterSession({ session, connection_id: connectionId });

      const { fn, calls } = (() => {
        const calls: Array<{ project: string; agent: AgentId }> = [];
        return {
          calls,
          fn: async (project: string, agent: AgentId) => {
            calls.push({ project, agent });
          },
        };
      })();

      const summary = await runBootScopeRestore({
        stateRoot: dir,
        discoveryRoot: DAEMON_OWNER.discoveryRoot,
        storage,
        ensureCommsForSession: fn,
        now: () => NOW,
        isPidAlive: (pid) => pid === process.pid,
        pathExists: async () => false,
      });

      assert.equal(summary.restored, 0);
      assert.equal(summary.candidates, 0);
      assert.equal(calls.length, 0);
      assert.equal((await storage.getSession(session))?.status, "ended");
    });
  });
});

describe("AGE-59 Pi bridge connection-id replay", () => {
  it("replays register with same connection_id after simulated crash", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_replay_1" as SessionId;
      const connectionId = "pi:stable-runtime";
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      const first = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
      });
      assert.equal(first.ok, true);
      // Simulate daemon crash: no socket.close(), stale lease row remains.

      const replay = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
      });
      assert.equal(replay.ok, true);
    });
  });

  it("fails re-acquire when replay uses a different connection_id", async () => {
    await withStorage(async ({ storage }) => {
      const session = "pi_replay_2" as SessionId;
      const bridge = new PiBridge({ storage, bus: {} as never, pendingInbound: [] });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: "pi:stable-a",
      });
      const replay = await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: "pi:random-new",
      });
      assert.equal(replay.ok, false);
      assert.match(replay.reason ?? "", /lease already held/);
    });
  });

  it("boot-restore restores Pi scope when daemon-owner discovery root matches", async () => {
    await withStorage(async ({ storage, dir }) => {
      const session = "pi_replay_3" as SessionId;
      const connectionId = "pi:stable-boot";
      const bridge = new PiBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        daemonOwner: DAEMON_OWNER,
      });
      await bridge.registerSession({
        session,
        project: PROJECT_A,
        connection_id: connectionId,
        host: { pid: process.pid, label: "pi" },
      });

      const calls: Array<{ project: string; agent: AgentId }> = [];
      const summary = await runBootScopeRestore({
        stateRoot: dir,
        discoveryRoot: DAEMON_OWNER.discoveryRoot,
        storage,
        ensureCommsForSession: async (project, agent) => {
          calls.push({ project, agent });
        },
        now: () => RECENT + DEFAULT_BOOT_RESTORE_RECENCY_MS / 2,
        isPidAlive: (pid) => pid === process.pid,
        pathExists: async () => false,
      });

      assert.equal(summary.restored, 1);
      assert.equal(summary.skipped_no_daemon_owner, 0);
      assert.equal(summary.skipped_foreign_owner, 0);
      assert.deepEqual(calls, [{ project: PROJECT_A, agent: "pi" }]);
    });
  });
});

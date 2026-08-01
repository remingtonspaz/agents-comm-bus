import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import {
  deliveryRowFromEntry,
  rehydratePendingInboundForScope,
} from "../../core-daemon/runtime/durable-inbound.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type { EnsureCommsForSession } from "../../core-daemon/runtime/agent-bridge.js";
import {
  createSessionOwnerLiveness,
  type SessionOwnerLiveness,
} from "../../core-daemon/runtime/session-owner-liveness.js";
import { serializeAccountLabelScope } from "../../core-daemon/session-label-scope.js";
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
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
  SCHEMA_VERSION_MESSAGE,
} from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

const TELEGRAM = "telegram" as CommId;
const DISCORD = "discord" as CommId;
const CODEX = "codex" as AgentId;
const PROJECT = normalizeProjectPath("/repo/age90");
const BOT_TG = "11111" as AccountId;
const BOT_DC = "22222" as AccountId;
const BOT_CONSULT = "33333" as AccountId;
const APP_SERVER_URL = "ws://127.0.0.1:4509";
const RECENT = 1_700_000_000_000;
/** Node setInterval cap — prevents owner-check timers firing before storage.close(). */
const DISABLED_OWNER_CHECK_INTERVAL_MS = 2_147_483_647;

async function releaseConnectionPreservingOwner(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  session: SessionId,
): Promise<void> {
  const record = await storage.getSession(session);
  const connectionId = record?.lease_holder_connection_id;
  if (!connectionId) return;
  await storage.releaseSessionConnectionLeasePreservingOwner(
    session,
    connectionId,
    Date.now(),
  );
}

class FakeCodexClient {
  readonly steerCalls: string[] = [];
  steerOk = true;
  wakeOk = true;

  async call(): Promise<unknown> {
    return {};
  }

  async listLoadedThreads(): Promise<unknown> {
    return { data: ["thread-1"] };
  }

  async listThreadTurns(): Promise<unknown> {
    return { data: [{ id: "turn-1", status: "inProgress" }] };
  }

  async startTurn(threadId: string): Promise<unknown> {
    this.steerCalls.push(`turn/start:${threadId}`);
    return {};
  }

  async steerTurn(threadId: string, _text: string, _expectedTurnId: string): Promise<unknown> {
    this.steerCalls.push(`turn/steer:${threadId}`);
    return {};
  }

  async wakeMostRecentThread(_text?: string): Promise<{ ok: boolean; threadId: string; method: string }> {
    if (this.wakeOk) {
      await this.startTurn("thread-1");
      return { ok: true, threadId: "thread-1", method: "turn/start" };
    }
    return { ok: false, threadId: "thread-1", method: "turn/start" };
  }

  async steerMostRecentThread(_text = ""): Promise<{ ok: boolean; threadId: string; method: string }> {
    if (this.steerOk) {
      await this.steerTurn("thread-1", _text, "turn-1");
      return { ok: true, threadId: "thread-1", method: "turn/steer" };
    }
    return { ok: false, threadId: "thread-1", method: "turn/steer" };
  }
}

function registration(
  comm: CommId,
  botUserId: string,
  accountLabel = "main",
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT,
    comm,
    agent: CODEX,
    account_label: accountLabel,
    registration_id: `reg-${comm}-${botUserId}`,
    bot_user_id: botUserId,
    credentials_ref: "file:/dev/null",
    created_at: 1,
    updated_at: 1,
  };
}

function conversation(
  comm: CommId,
  botUserId: string,
  conversationId: ConversationId,
  accountLabel = "main",
): Conversation {
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: PROJECT,
    agent: CODEX,
    comm,
    account_label: accountLabel,
    bot_user_id: botUserId,
    registration_id: `reg-${comm}-${botUserId}`,
    chat_native_id: `chat-${comm}`,
    thread_native_id: null,
    conversation_id: conversationId,
    last_inbound_at: 1000,
    last_outbound_at: null,
    last_message_id: `${comm}:1` as MessageId,
    created_at: 1000,
  };
}

function message(
  comm: CommId,
  botUserId: AccountId,
  overrides: Partial<Message> = {},
): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: `${comm}:1` as MessageId,
    chat: {
      comm,
      account: botUserId,
      chat_native_id: `chat-${comm}`,
    },
    sender: {
      id: "user-1",
      display_name: "User",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm },
    text: "hello",
    hop_count: 0,
    received_at: 1000,
    platform_message_id: "1",
    ...overrides,
  };
}

function pendingEntry(
  comm: CommId,
  botUserId: string,
  conversationId: ConversationId,
  receivedAt: number,
  accountLabel = "main",
  messageId?: MessageId,
): PendingInboundEntry {
  return {
    message: message(comm, botUserId as AccountId, {
      received_at: receivedAt,
      message_id: messageId ?? (`${comm}:1` as MessageId),
    }),
    conversation: conversation(comm, botUserId, conversationId, accountLabel),
  };
}

function daemonEnsureWithRehydrate(input: {
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  transcripts: JsonlTranscriptStore;
  audit: JsonlAuditStore;
  pendingInbound: PendingInboundEntry[];
  rehydrated?: boolean;
  onCall?: () => void;
}): EnsureCommsForSession {
  return async (project, agent) => {
    input.onCall?.();
    await rehydratePendingInboundForScope({
      storage: input.storage,
      transcripts: input.transcripts,
      audit: input.audit,
      queue: input.pendingInbound,
      project,
      agent,
    });
    return { rehydrated: input.rehydrated ?? true };
  };
}

async function seedDurablePending(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  transcripts: JsonlTranscriptStore,
  entry: PendingInboundEntry,
  enqueuedAt: number,
): Promise<void> {
  const comm = entry.message.chat.comm;
  const bot = entry.message.chat.account;
  await storage.putAccountRegistration(
    registration(comm, String(bot), entry.conversation.account_label),
  );
  await storage.upsertConversation(entry.conversation);
  await transcripts.append({
    conversation_id: entry.conversation.conversation_id,
    timestamp: entry.message.received_at,
    direction: "inbound",
    message_id: entry.message.message_id,
    payload: entry.message,
  });
  await storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, enqueuedAt));
}

function makeBridge(input: {
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  pendingInbound: PendingInboundEntry[];
  fakeClient?: FakeCodexClient;
  ensureCommsForSession?: EnsureCommsForSession;
  sessionOwnerIsLive?: SessionOwnerLiveness;
}): { bridge: CodexBridge; client: FakeCodexClient } {
  const client = input.fakeClient ?? new FakeCodexClient();
  const bridge = new CodexBridge({
    storage: input.storage,
    bus: {} as never,
    pendingInbound: input.pendingInbound,
    appServerClientFactory: () => client,
    ensureCommsForSession: input.ensureCommsForSession ?? (async () => ({ rehydrated: true })),
    sessionOwnerIsLive: input.sessionOwnerIsLive,
    sessionOwnerCheckIntervalMs: DISABLED_OWNER_CHECK_INTERVAL_MS,
  });
  return { bridge, client };
}

describe("AGE-90 Codex deliverability-edge redrive", () => {
  it("redrives queued pending inbound when a session becomes deliverable", async () => {
    const dir = await makeTempDir("acb-age90-queued-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [];
    const convId = "conv-tg" as ConversationId;
    const entry = pendingEntry(TELEGRAM, String(BOT_TG), convId, 2000);
    pendingInbound.push(entry);
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.upsertConversation(entry.conversation);

    const { bridge, client } = makeBridge({ storage, pendingInbound });

    try {
      assert.equal(client.steerCalls.length, 0);

      const result = await bridge.registerSession({
        session: "codex-s1" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 100,
        owner_process_label: "codex",
      });

      assert.equal(result.ok, true);
      assert.equal(client.steerCalls.length, 1);
      assert.equal(pendingInbound.length, 0);
    } finally {
      await storage.close();
    }
  });

  it("fires exactly one redrive across repeated hook-path registrations", async () => {
    const dir = await makeTempDir("acb-age90-repeat-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [];
    const entry = pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 2000);
    pendingInbound.push(entry);
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.upsertConversation(entry.conversation);

    const livePid = 101;
    const sessionOwnerIsLive = createSessionOwnerLiveness({
      now: () => RECENT,
      isPidAlive: (pid) => pid === livePid,
    });
    const { bridge, client } = makeBridge({ storage, pendingInbound, sessionOwnerIsLive });
    const session = "codex-s1" as SessionId;
    const registerParams = {
      session,
      project: PROJECT,
      app_server_url: APP_SERVER_URL,
      owner_process_pid: livePid,
    };

    try {
      await bridge.registerSession({
        ...registerParams,
        connection_id: "codex:conn-1",
      });
      assert.equal(client.steerCalls.length, 1);
      assert.equal(pendingInbound.length, 0);

      const freshEntry = pendingEntry(
        TELEGRAM,
        String(BOT_TG),
        "conv-tg" as ConversationId,
        5000,
        "main",
        "telegram:fresh" as MessageId,
      );
      pendingInbound.push(freshEntry);

      await bridge.registerSession({
        ...registerParams,
        connection_id: "codex:conn-2",
        replace_existing_lease: true,
      });
      assert.equal(client.steerCalls.length, 1, "second hook must not re-redrive");
      assert.equal(pendingInbound.length, 1, "fresh row must remain pending");

      await bridge.registerSession({
        ...registerParams,
        connection_id: "codex:conn-3",
        replace_existing_lease: true,
      });
      assert.equal(client.steerCalls.length, 1, "third hook must not re-redrive");
      assert.equal(pendingInbound.length, 1, "fresh row must remain pending");
      assert.equal(pendingInbound[0]?.message.message_id, "telegram:fresh");
    } finally {
      await storage.close();
    }
  });

  it("coalesces one steer across two comm conversations in the same scope", async () => {
    const dir = await makeTempDir("acb-age90-coalesce-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [
      pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 1000),
      pendingEntry(DISCORD, String(BOT_DC), "conv-dc" as ConversationId, 2000),
    ];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.putAccountRegistration(registration(DISCORD, String(BOT_DC)));
    for (const entry of pendingInbound) {
      await storage.upsertConversation(entry.conversation);
    }

    const { bridge, client } = makeBridge({
      storage,
      pendingInbound,
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });

    try {
      await bridge.registerSession({
        session: "codex-s1" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 100,
      });

      assert.equal(client.steerCalls.length, 1);
      assert.equal(pendingInbound.length, 0);
    } finally {
      await storage.close();
    }
  });

  it("redrives durable-only pending rows after rehydration, not before", async () => {
    const dir = await makeTempDir("acb-age90-durable-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const transcripts = new JsonlTranscriptStore(dir);
    const audit = new JsonlAuditStore(dir);
    const pendingInbound: PendingInboundEntry[] = [];
    const entry = pendingEntry(TELEGRAM, String(BOT_TG), "conv-durable" as ConversationId, 3000);
    await seedDurablePending(storage, transcripts, entry, 3000);

    const { bridge, client } = makeBridge({
      storage,
      pendingInbound,
      ensureCommsForSession: daemonEnsureWithRehydrate({
        storage,
        transcripts,
        audit,
        pendingInbound,
      }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });

    try {
      assert.equal(pendingInbound.length, 0);
      assert.equal(client.steerCalls.length, 0);

      await bridge.registerSession({
        session: "codex-s1" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 100,
      });

      assert.equal(pendingInbound.length, 0);
      assert.equal(client.steerCalls.length, 1);
    } finally {
      await storage.close();
    }
  });

  it("skips redrive when rehydration is not confirmed (fail closed)", async () => {
    const dir = await makeTempDir("acb-age90-no-rehydrate-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [
      pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 2000),
    ];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.upsertConversation(pendingInbound[0].conversation);

    const { bridge, client } = makeBridge({
      storage,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: false }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });

    try {
      await bridge.registerSession({
        session: "codex-s1" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 100,
      });
      assert.equal(client.steerCalls.length, 0);
      assert.equal(pendingInbound.length, 1);
    } finally {
      await storage.close();
    }
  });

  it("redrives on dead-owner to live-owner transition but not on same live owner", async () => {
    const dir = await makeTempDir("acb-age90-owner-edge-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [];
    const livePid = 202;
    const session = "codex-s1" as SessionId;
    let alivePids = new Set<number>([livePid]);
    const sessionOwnerIsLive: SessionOwnerLiveness = createSessionOwnerLiveness({
      now: () => RECENT,
      isPidAlive: (pid) => alivePids.has(pid),
    });

    const { bridge, client } = makeBridge({ storage, pendingInbound, sessionOwnerIsLive });

    try {
      await bridge.registerSession({
        session,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: livePid,
      });
      await releaseConnectionPreservingOwner(storage, session);

      alivePids = new Set();
      pendingInbound.push(
        pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 4000),
      );
      await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
      await storage.upsertConversation(pendingInbound[0].conversation);

      alivePids = new Set([303]);
      await bridge.registerSession({
        session,
        project: PROJECT,
        connection_id: "codex:conn-2",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 303,
        replace_existing_lease: true,
      });
      const afterRevive = client.steerCalls.length;

      await bridge.registerSession({
        session,
        project: PROJECT,
        connection_id: "codex:conn-3",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 303,
        replace_existing_lease: true,
      });
      const afterSameOwner = client.steerCalls.length;

      assert.equal(afterRevive, 1);
      assert.equal(afterSameOwner, afterRevive);
    } finally {
      await storage.close();
    }
  });

  it("redrives labelled and unlabelled sessions independently", async () => {
    const dir = await makeTempDir("acb-age90-label-scope-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const labeledScope = serializeAccountLabelScope({ telegram: "consultant" });
    const mainEntry = pendingEntry(
      TELEGRAM,
      String(BOT_TG),
      "conv-main" as ConversationId,
      1000,
      "main",
    );
    const consultEntry = pendingEntry(
      TELEGRAM,
      String(BOT_CONSULT),
      "conv-consult" as ConversationId,
      2000,
      "consultant",
      "telegram:consult" as MessageId,
    );
    const pendingInbound: PendingInboundEntry[] = [mainEntry, consultEntry];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG), "main"));
    await storage.putAccountRegistration(
      registration(TELEGRAM, String(BOT_CONSULT), "consultant"),
    );
    await storage.upsertConversation(mainEntry.conversation);
    await storage.upsertConversation(consultEntry.conversation);
    // Live labeled sibling reserves the consultant registration before the
    // unlabeled hook registers, so unlabeled redrive must not sweep it.
    await storage.upsertSession({
      schema_version: 1,
      session_id: "codex-labeled" as SessionId,
      agent: CODEX,
      project: PROJECT,
      created_at: RECENT,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: 101,
      lease_owner_process_label: "codex",
      lease_owner_process_registered_at: RECENT,
      lease_owner_daemon_discovery_root: null,
      lease_owner_daemon_checkout_root: null,
      lease_owner_daemon_state_root: null,
      lease_owner_daemon_bin: null,
      lease_owner_daemon_authority_rank: null,
      most_recent_inbound_conversation_id: null,
      account_label_scope: labeledScope,
      status: "active",
    });

    const client = new FakeCodexClient();
    const bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      appServerClientFactory: () => client,
      ensureCommsForSession: async () => ({ rehydrated: true }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: (pid) => pid === 101,
      }),
      sessionOwnerCheckIntervalMs: DISABLED_OWNER_CHECK_INTERVAL_MS,
    });

    try {
      await bridge.registerSession({
        session: "codex-unlabeled" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-main",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 100,
      });
      assert.equal(client.steerCalls.length, 1);
      assert.equal(pendingInbound.length, 1);
      assert.equal(pendingInbound[0]?.conversation.conversation_id, "conv-consult");

      await bridge.registerSession({
        session: "codex-labeled" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-consult",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 101,
        account_label_scope: labeledScope,
      });
      assert.equal(client.steerCalls.length, 2);
      assert.equal(pendingInbound.length, 0);
    } finally {
      await storage.close();
    }
  });

  it("redrives when a daemon restart leaves a live owner but no local route", async () => {
    const dir = await makeTempDir("acb-age90-route-edge-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [];
    const livePid = 202;
    const sessionOwnerIsLive: SessionOwnerLiveness = createSessionOwnerLiveness({
      now: () => RECENT,
      isPidAlive: () => true,
    });
    const makeFreshBridge = () =>
      makeBridge({ storage, pendingInbound, sessionOwnerIsLive });

    try {
      const first = makeFreshBridge();
      const session = "codex-s1" as SessionId;
      await first.bridge.registerSession({
        session,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: livePid,
      });
      await releaseConnectionPreservingOwner(storage, session);
      assert.equal(first.client.steerCalls.length, 0);

      pendingInbound.push(
        pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 4000),
      );
      await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
      await storage.upsertConversation(pendingInbound[0].conversation);

      const restarted = makeFreshBridge();
      await restarted.bridge.registerSession({
        session,
        project: PROJECT,
        connection_id: "codex:conn-2",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: livePid,
      });

      assert.equal(restarted.client.steerCalls.length, 1);
      assert.equal(pendingInbound.length, 0);
    } finally {
      await storage.close();
    }
  });

  it("retains pending rows when app-server acceptance fails", async () => {
    const dir = await makeTempDir("acb-age90-wake-fail-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const pendingInbound: PendingInboundEntry[] = [
      pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 2000),
    ];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.upsertConversation(pendingInbound[0].conversation);

    const client = new FakeCodexClient();
    client.steerOk = false;
    client.wakeOk = false;
    const { bridge } = makeBridge({ storage, pendingInbound, fakeClient: client });

    try {
      await bridge.registerSession({
        session: "codex-s1" as SessionId,
        project: PROJECT,
        connection_id: "codex:conn-1",
        app_server_url: APP_SERVER_URL,
        owner_process_pid: 100,
      });

      assert.equal(pendingInbound.length, 1);
    } finally {
      await storage.close();
    }
  });
});

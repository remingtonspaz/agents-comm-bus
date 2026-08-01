import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
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
const CLAUDE = "claude" as AgentId;
const PROJECT = normalizeProjectPath("/repo/age89");
const BOT_TG = "11111" as AccountId;
const BOT_DC = "22222" as AccountId;
const BOT_CONSULT = "33333" as AccountId;
const RECENT = 1_700_000_000_000;

class FakeSocket {
  private closeHandler: (() => void) | null = null;

  once(event: "close", handler: () => void): void {
    if (event === "close") this.closeHandler = handler;
  }

  close(): void {
    this.closeHandler?.();
  }
}

async function triggerExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
    agent: CLAUDE,
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
    agent: CLAUDE,
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
): PendingInboundEntry {
  return {
    message: message(comm, botUserId as AccountId, { received_at: receivedAt }),
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

describe("AGE-89 Claude deliverability-edge redrive", () => {
  it("redrives queued pending inbound when a session becomes deliverable", async () => {
    const dir = await makeTempDir("acb-age89-queued-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const wakeDir = join(dir, "wake-main");
    const pendingInbound: PendingInboundEntry[] = [];
    const convId = "conv-tg" as ConversationId;
    const entry = pendingEntry(TELEGRAM, String(BOT_TG), convId, 2000);
    pendingInbound.push(entry);
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.upsertConversation(entry.conversation);

    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: true }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });

    try {
      const triggerPath = join(wakeDir, "trigger-enter");
      assert.equal(await triggerExists(triggerPath), false);

      const result = await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-1",
        wake_dir: wakeDir,
        owner_process_pid: 100,
        owner_process_label: "claude",
      });

      assert.equal(result.ok, true);
      assert.equal(await triggerExists(triggerPath), true);
      assert.equal(pendingInbound.length, 1, "daemon must not drain pendingInbound");
    } finally {
      await storage.close();
    }
  });

  it("fires exactly one redrive across repeated hook-path registrations", async () => {
    const dir = await makeTempDir("acb-age89-repeat-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const wakeDir = join(dir, "wake-repeat");
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
    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: true }),
      sessionOwnerIsLive,
    });
    const triggerPath = join(wakeDir, "trigger-enter");

    try {
      const socket1 = new FakeSocket();
      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-1",
        wake_dir: wakeDir,
        owner_process_pid: livePid,
      }, socket1);
      const firstTrigger = await readFile(triggerPath, "utf8");
      socket1.close();

      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-2",
        wake_dir: wakeDir,
        owner_process_pid: livePid,
      });
      const secondTrigger = await readFile(triggerPath, "utf8");

      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-3",
        wake_dir: wakeDir,
        owner_process_pid: livePid,
      });
      const thirdTrigger = await readFile(triggerPath, "utf8");

      assert.equal(firstTrigger.length > 0, true);
      assert.equal(secondTrigger, firstTrigger, "second hook must not re-redrive");
      assert.equal(thirdTrigger, firstTrigger, "third hook must not re-redrive");
    } finally {
      await storage.close();
    }
  });

  it("coalesces one wake across two comm conversations in the same scope", async () => {
    const dir = await makeTempDir("acb-age89-coalesce-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const wakeDir = join(dir, "wake-coalesce");
    const pendingInbound: PendingInboundEntry[] = [
      pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 1000),
      pendingEntry(DISCORD, String(BOT_DC), "conv-dc" as ConversationId, 2000),
    ];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.putAccountRegistration(registration(DISCORD, String(BOT_DC)));
    for (const entry of pendingInbound) {
      await storage.upsertConversation(entry.conversation);
    }

    let redriveCalls = 0;
    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: true }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });
    const original = bridge.onInboundConversation.bind(bridge);
    bridge.onInboundConversation = async (conversation, message) => {
      redriveCalls += 1;
      return original(conversation, message);
    };

    try {
      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-1",
        wake_dir: wakeDir,
        owner_process_pid: 100,
      });

      assert.equal(redriveCalls, 1);
      assert.equal(pendingInbound.length, 2);
      assert.equal(await triggerExists(join(wakeDir, "trigger-enter")), true);
    } finally {
      await storage.close();
    }
  });

  it("redrives durable-only pending rows after rehydration, not before", async () => {
    const dir = await makeTempDir("acb-age89-durable-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const transcripts = new JsonlTranscriptStore(dir);
    const audit = new JsonlAuditStore(dir);
    const wakeDir = join(dir, "wake-durable");
    const pendingInbound: PendingInboundEntry[] = [];
    const entry = pendingEntry(TELEGRAM, String(BOT_TG), "conv-durable" as ConversationId, 3000);
    await seedDurablePending(storage, transcripts, entry, 3000);

    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
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
      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-1",
        wake_dir: wakeDir,
        owner_process_pid: 100,
      });

      assert.equal(pendingInbound.length, 1);
      assert.equal(await triggerExists(join(wakeDir, "trigger-enter")), true);
    } finally {
      await storage.close();
    }
  });

  it("skips redrive when rehydration is not confirmed (fail closed)", async () => {
    const dir = await makeTempDir("acb-age89-no-rehydrate-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const wakeDir = join(dir, "wake-fail-closed");
    const pendingInbound: PendingInboundEntry[] = [
      pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 2000),
    ];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
    await storage.upsertConversation(pendingInbound[0].conversation);

    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: false }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });

    try {
      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-1",
        wake_dir: wakeDir,
        owner_process_pid: 100,
      });
      assert.equal(await triggerExists(join(wakeDir, "trigger-enter")), false);
    } finally {
      await storage.close();
    }
  });

  it("redrives on dead-owner to live-owner transition but not on same live owner", async () => {
    const dir = await makeTempDir("acb-age89-owner-edge-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const wakeDir = join(dir, "wake-owner");
    const pendingInbound: PendingInboundEntry[] = [];
    const livePid = 202;
    let alivePids = new Set<number>([livePid]);
    const sessionOwnerIsLive: SessionOwnerLiveness = createSessionOwnerLiveness({
      now: () => RECENT,
      isPidAlive: (pid) => alivePids.has(pid),
    });

    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: true }),
      sessionOwnerIsLive,
    });
    const triggerPath = join(wakeDir, "trigger-enter");

    try {
      const socket = new FakeSocket();
      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-1",
        wake_dir: wakeDir,
        owner_process_pid: livePid,
      }, socket);
      socket.close();

      alivePids = new Set();
      pendingInbound.push(
        pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 4000),
      );
      await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
      await storage.upsertConversation(pendingInbound[0].conversation);

      alivePids = new Set([303]);
      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-2",
        wake_dir: wakeDir,
        owner_process_pid: 303,
      });
      const afterRevive = await readFile(triggerPath, "utf8");

      await bridge.registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-3",
        wake_dir: wakeDir,
        owner_process_pid: 303,
      });
      const afterSameOwner = await readFile(triggerPath, "utf8");

      assert.equal(afterRevive.length > 0, true);
      assert.equal(afterSameOwner, afterRevive);
    } finally {
      await storage.close();
    }
  });

  it("redrives labelled and unlabelled sessions independently", async () => {
    const dir = await makeTempDir("acb-age89-label-scope-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const labeledScope = serializeAccountLabelScope({ telegram: "consultant" });
    const wakeUnlabeled = join(dir, "wake-unlabeled");
    const wakeLabeled = join(dir, "wake-labeled");
    const pendingInbound: PendingInboundEntry[] = [
      pendingEntry(TELEGRAM, String(BOT_TG), "conv-main" as ConversationId, 1000, "main"),
      pendingEntry(
        TELEGRAM,
        String(BOT_CONSULT),
        "conv-consult" as ConversationId,
        2000,
        "consultant",
      ),
    ];
    await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG), "main"));
    await storage.putAccountRegistration(
      registration(TELEGRAM, String(BOT_CONSULT), "consultant"),
    );
    for (const entry of pendingInbound) {
      await storage.upsertConversation(entry.conversation);
    }

    const bridge = new ClaudeBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      ensureCommsForSession: async () => ({ rehydrated: true }),
      sessionOwnerIsLive: createSessionOwnerLiveness({
        now: () => RECENT,
        isPidAlive: () => true,
      }),
    });

    try {
      await bridge.registerSession({
        session: "claude-unlabeled" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-main",
        wake_dir: wakeUnlabeled,
        owner_process_pid: 100,
      });
      assert.equal(await triggerExists(join(wakeUnlabeled, "trigger-enter")), true);
      assert.equal(await triggerExists(join(wakeLabeled, "trigger-enter")), false);

      await bridge.registerSession({
        session: "claude-labeled" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-consult",
        wake_dir: wakeLabeled,
        owner_process_pid: 101,
        account_label_scope: labeledScope,
      });
      assert.equal(await triggerExists(join(wakeLabeled, "trigger-enter")), true);
      assert.equal(pendingInbound.length, 2);
    } finally {
      await storage.close();
    }
  });

  it("redrives when a daemon restart leaves a live owner but no local wake route", async () => {
    // Route-edge coverage (Codex review B2): the hasDaemonLocalWakeRoute half of
    // isSessionLocallyDeliverable must be load-bearing. A restarted daemon has an
    // empty in-memory wake registry; the preserved owner PID is still live. The
    // false->true edge must come from route CREATION on re-registration, and a
    // predicate without the route conjunct must turn this test red.
    const dir = await makeTempDir("acb-age89-route-edge-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const wakeDir = join(dir, "wake-route");
    const pendingInbound: PendingInboundEntry[] = [];
    const livePid = 202;
    const sessionOwnerIsLive: SessionOwnerLiveness = createSessionOwnerLiveness({
      now: () => RECENT,
      isPidAlive: () => true,
    });
    const triggerPath = join(wakeDir, "trigger-enter");
    const makeBridge = () =>
      new ClaudeBridge({
        storage,
        bus: {} as never,
        pendingInbound,
        ensureCommsForSession: async () => ({ rehydrated: true }),
        sessionOwnerIsLive,
      });

    try {
      // Pre-restart: session registers (empty queue, so no wake), then its hook
      // socket closes — owner PID stamps are preserved, connection lease is not.
      const socket = new FakeSocket();
      await makeBridge().registerSession(
        {
          session: "claude-s1" as SessionId,
          project: PROJECT,
          connection_id: "claude:conn-1",
          wake_dir: wakeDir,
          owner_process_pid: livePid,
        },
        socket,
      );
      socket.close();
      assert.equal(await triggerExists(triggerPath), false);

      // Work arrives while the "daemon is down".
      pendingInbound.push(
        pendingEntry(TELEGRAM, String(BOT_TG), "conv-tg" as ConversationId, 4000),
      );
      await storage.putAccountRegistration(registration(TELEGRAM, String(BOT_TG)));
      await storage.upsertConversation(pendingInbound[0].conversation);

      // Post-restart: a fresh bridge has NO wake route for the session even
      // though the owner PID is live. Re-registration must create the route,
      // producing the deliverability edge that redrives the queued row.
      await makeBridge().registerSession({
        session: "claude-s1" as SessionId,
        project: PROJECT,
        connection_id: "claude:conn-2",
        wake_dir: wakeDir,
        owner_process_pid: livePid,
      });

      assert.equal(await triggerExists(triggerPath), true);
      assert.equal(pendingInbound.length, 1); // redrive never drains
    } finally {
      await storage.close();
    }
  });
});

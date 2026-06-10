import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MessageBus } from "../../core-daemon/bus.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import {
  acknowledgePendingInboundEntries,
  deliveryRowFromEntry,
  durableInboundKey,
  queueHasDurableKey,
  rehydratePendingInboundForScope,
} from "../../core-daemon/runtime/durable-inbound.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { drainPendingInbound } from "../../core-daemon/daemon.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  AuditEvent,
  CommId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  QueryRecord,
  Session,
  SessionId,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
  SCHEMA_VERSION_MESSAGE,
  SCHEMA_VERSION_QUERY,
} from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const CODEX = "codex" as AgentId;
const PROJECT = normalizeProjectPath("/repo");
const BOT = "12345" as AccountId;
const CODEX_BOT = "67890" as AccountId;

async function withFixture<T>(
  test: (ctx: FixtureContext) => Promise<T>,
): Promise<T> {
  const dir = await makeTempDir("acb-age56-");
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  const transcripts = new JsonlTranscriptStore(dir);
  const audit = new RecordingAuditStore();
  try {
    return await test({ dir, storage, transcripts, audit });
  } finally {
    await storage.close();
  }
}

interface FixtureContext {
  dir: string;
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  transcripts: JsonlTranscriptStore;
  audit: RecordingAuditStore;
}

function registration(
  agent: AgentId,
  botUserId: string,
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT,
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
): Conversation {
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: PROJECT,
    agent,
    comm: TELEGRAM,
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
  agentBot: AccountId,
  overrides: Partial<Message> = {},
): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: "telegram:1" as MessageId,
    chat: {
      comm: TELEGRAM,
      account: agentBot,
      chat_native_id: "chat-1",
    },
    sender: {
      id: "user-1",
      display_name: "User",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm: TELEGRAM },
    text: "hello",
    hop_count: 0,
    received_at: 1000,
    platform_message_id: "1",
    ...overrides,
  };
}

function pendingEntry(
  agent: AgentId,
  botUserId: string,
  conversationId: ConversationId,
  overrides: Partial<Message> = {},
): PendingInboundEntry {
  return {
    message: message(botUserId as AccountId, overrides),
    conversation: conversation(agent, botUserId, conversationId),
  };
}

async function seedConversationAndTranscript(
  ctx: FixtureContext,
  agent: AgentId,
  botUserId: string,
  conversationId: ConversationId,
  msg: Message,
): Promise<void> {
  await ctx.storage.putAccountRegistration(registration(agent, botUserId));
  await ctx.storage.upsertConversation(conversation(agent, botUserId, conversationId));
  await ctx.transcripts.append({
    conversation_id: conversationId,
    timestamp: msg.received_at,
    direction: "inbound",
    message_id: msg.message_id,
    payload: msg,
  });
}

async function listPendingRows(
  storage: FixtureContext["storage"],
  agent: AgentId,
) {
  return storage.listPendingInboundDeliveries({ project: PROJECT, agent });
}

describe("AGE-56 durable inbound delivery", () => {
  it("records durable pending delivery only for dispatchable inbound, not query replies", async () => {
    await withFixture(async (ctx) => {
      await ctx.storage.putAccountRegistration(registration(CLAUDE, String(BOT)));
      const conversationId = "conv-claude" as ConversationId;
      await ctx.storage.upsertConversation(conversation(CLAUDE, String(BOT), conversationId));
      await ctx.storage.upsertSession({
        schema_version: 1,
        session_id: "session-1" as SessionId,
        agent: CLAUDE,
        project: PROJECT,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
        most_recent_inbound_conversation_id: conversationId,
        status: "active",
      });
      await ctx.storage.insertQuery({
        schema_version: SCHEMA_VERSION_QUERY,
        query_id: "query-1" as never,
        agent: CLAUDE,
        session: "session-1" as SessionId,
        kind: "approval",
        prompt_text: "Allow?",
        created_at: 1,
        ttl_seconds: 300,
        origin_chat_id: conversationId,
        source_message_id: null,
        resolved_at: null,
        resolution: null,
        options_json: null,
      } satisfies QueryRecord);

      const bus = new MessageBus({
        project: PROJECT,
        storage: ctx.storage,
        transcripts: ctx.transcripts,
        audit: ctx.audit,
        now: () => 2000,
      });
      const pendingInbound: PendingInboundEntry[] = [];
      bus.setDispatchSink({
        enqueueInbound: async (inboundMessage, inboundConversation) => {
          const entry = { message: inboundMessage, conversation: inboundConversation };
          await ctx.storage.recordPendingInboundDelivery(
            deliveryRowFromEntry(entry, Date.now()),
          );
          pendingInbound.push(entry);
        },
      });

      await bus.receiveInbound(message(BOT, { text: "y" }));
      assert.equal(await listPendingRows(ctx.storage, CLAUDE).then((rows) => rows.length), 0);
      assert.equal(pendingInbound.length, 0);

      await bus.receiveInbound(message(BOT, {
        message_id: "telegram:2" as MessageId,
        platform_message_id: "2",
        text: "work request",
      }));
      assert.equal(await listPendingRows(ctx.storage, CLAUDE).then((rows) => rows.length), 1);
      assert.equal(pendingInbound.length, 1);
    });
  });

  it("rehydrates one pending entry from durable rows and transcript payload", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-claude" as ConversationId;
      const msg = message(BOT);
      await seedConversationAndTranscript(ctx, CLAUDE, String(BOT), conversationId, msg);
      const entry = pendingEntry(CLAUDE, String(BOT), conversationId);
      await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000));

      const queue: PendingInboundEntry[] = [];
      const count = await rehydratePendingInboundForScope({
        storage: ctx.storage,
        transcripts: ctx.transcripts,
        audit: ctx.audit,
        queue,
        project: PROJECT,
        agent: CLAUDE,
      });

      assert.equal(count, 1);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].message.text, "hello");
    });
  });

  it("rehydrate dedupes when the entry is already in memory", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-claude" as ConversationId;
      const msg = message(BOT);
      await seedConversationAndTranscript(ctx, CLAUDE, String(BOT), conversationId, msg);
      const entry = pendingEntry(CLAUDE, String(BOT), conversationId);
      await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000));

      const queue: PendingInboundEntry[] = [entry];
      const count = await rehydratePendingInboundForScope({
        storage: ctx.storage,
        transcripts: ctx.transcripts,
        audit: ctx.audit,
        queue,
        project: PROJECT,
        agent: CLAUDE,
      });

      assert.equal(count, 0);
      assert.equal(queue.length, 1);
    });
  });

  it("acknowledges Claude drain so durable rows are not replayed again", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-claude" as ConversationId;
      const msg = message(BOT);
      await seedConversationAndTranscript(ctx, CLAUDE, String(BOT), conversationId, msg);
      const entry = pendingEntry(CLAUDE, String(BOT), conversationId);
      await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000));

      const pendingInbound = [entry];
      const bridge = new ClaudeBridge({
        storage: ctx.storage,
        bus: {} as never,
        audit: ctx.audit,
        pendingInbound,
      });
      await ctx.storage.upsertSession({
        schema_version: 1,
        session_id: "claude-session" as SessionId,
        agent: CLAUDE,
        project: PROJECT,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
        most_recent_inbound_conversation_id: null,
        status: "active",
      });

      const drained = await bridge.drainPendingInbound("claude-session" as SessionId);
      assert.equal(drained.length, 1);
      assert.equal(pendingInbound.length, 0);
      assert.equal((await listPendingRows(ctx.storage, CLAUDE)).length, 0);

      const replayed = await rehydratePendingInboundForScope({
        storage: ctx.storage,
        transcripts: ctx.transcripts,
        audit: ctx.audit,
        queue: pendingInbound,
        project: PROJECT,
        agent: CLAUDE,
      });
      assert.equal(replayed, 0);
    });
  });

  it("acknowledges Codex drain so durable rows are not replayed again", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-codex" as ConversationId;
      const msg = message(CODEX_BOT);
      await seedConversationAndTranscript(ctx, CODEX, String(CODEX_BOT), conversationId, msg);
      const entry = pendingEntry(CODEX, String(CODEX_BOT), conversationId);
      await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000));

      const pendingInbound = [entry];
      const bridge = new CodexBridge({
        storage: ctx.storage,
        bus: {} as never,
        audit: ctx.audit,
        pendingInbound,
      });
      await ctx.storage.upsertSession({
        schema_version: 1,
        session_id: "codex-session" as SessionId,
        agent: CODEX,
        project: PROJECT,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
        most_recent_inbound_conversation_id: null,
        status: "active",
      });

      const drained = await bridge.drainInbound({ session: "codex-session" });
      assert.equal(drained.length, 1);
      assert.equal(pendingInbound.length, 0);
      assert.equal((await listPendingRows(ctx.storage, CODEX)).length, 0);
    });
  });

  it("acknowledges durable rows after Codex successful steer removal", async () => {
    await withFixture(async (ctx) => {
      await ctx.storage.putAccountRegistration(registration(CODEX, String(CODEX_BOT)));
      const conversationId = "conv-codex" as ConversationId;
      const conv = conversation(CODEX, String(CODEX_BOT), conversationId);
      await ctx.storage.upsertConversation(conv);
      const pendingInbound: PendingInboundEntry[] = [
        pendingEntry(CODEX, String(CODEX_BOT), conversationId),
      ];
      await ctx.storage.recordPendingInboundDelivery(
        deliveryRowFromEntry(pendingInbound[0], 1000),
      );

      const bridge = new CodexBridge({
        storage: ctx.storage,
        bus: {} as never,
        audit: ctx.audit,
        pendingInbound,
        appServerClientFactory: () => ({
          async call() { return {}; },
          async listLoadedThreads() { return { data: ["thread-1"] }; },
          async listThreadTurns() { return { data: [{ id: "turn-1", status: "inProgress" }] }; },
          async steerTurn() { return {}; },
          async steerMostRecentThread() {
            return { ok: true, threadId: "thread-1", method: "turn/steer" };
          },
        }),
      });

      await bridge.registerSession({
        session: "codex-session" as SessionId,
        project: PROJECT,
        app_server_url: "ws://127.0.0.1:4509",
      });

      await bridge.onInboundConversation(conv);
      assert.equal(pendingInbound.length, 0);
      assert.equal((await listPendingRows(ctx.storage, CODEX)).length, 0);
    });
  });

  it("acknowledges durable rows for generic drain_pending_inbound", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-claude" as ConversationId;
      const entry = pendingEntry(CLAUDE, String(BOT), conversationId);
      await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000));
      const queue = [entry];

      const drained = drainPendingInbound(queue, {
        ownedAccountKeys: new Set([`telegram:${BOT}`]),
      });
      await acknowledgePendingInboundEntries(ctx.storage, drained);

      assert.equal(drained.length, 1);
      assert.equal(queue.length, 0);
      assert.equal((await listPendingRows(ctx.storage, CLAUDE)).length, 0);
    });
  });

  it("overflow spill audits memory loss while durable rows remain replayable", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-claude" as ConversationId;
      await ctx.storage.putAccountRegistration(registration(CLAUDE, String(BOT)));
      await ctx.storage.upsertConversation(conversation(CLAUDE, String(BOT), conversationId));

      const queue: PendingInboundEntry[] = [];
      const pendingInboundMax = 100;
      for (let i = 0; i < 101; i += 1) {
        const msg = message(BOT, {
          message_id: `telegram:${i}` as MessageId,
          platform_message_id: String(i),
          text: `msg-${i}`,
        });
        const entry = {
          message: msg,
          conversation: conversation(CLAUDE, String(BOT), conversationId),
        };
        await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000 + i));
        if (!queueHasDurableKey(queue, durableInboundKey(entry))) {
          queue.push(entry);
          if (queue.length > pendingInboundMax) {
            const spillCount = queue.length - pendingInboundMax;
            queue.splice(0, spillCount);
            await ctx.audit.append({
              timestamp: Date.now(),
              kind: "pending_inbound_overflow_spill",
              agent: CLAUDE,
              detail: { spilled_count: spillCount },
            });
          }
        }
      }

      assert.equal(queue.length, 100);
      const spill = ctx.audit.events.find((event) => event.kind === "pending_inbound_overflow_spill");
      assert.ok(spill);
      assert.equal((await listPendingRows(ctx.storage, CLAUDE)).length, 101);

      const msg0 = message(BOT, {
        message_id: "telegram:0" as MessageId,
        platform_message_id: "0",
        text: "msg-0",
      });
      await ctx.transcripts.append({
        conversation_id: conversationId,
        timestamp: msg0.received_at,
        direction: "inbound",
        message_id: msg0.message_id,
        payload: msg0,
      });

      const replayed = await rehydratePendingInboundForScope({
        storage: ctx.storage,
        transcripts: ctx.transcripts,
        audit: ctx.audit,
        queue,
        project: PROJECT,
        agent: CLAUDE,
      });
      assert.equal(replayed, 1);
      assert.ok(queue.some((entry) => entry.message.message_id === "telegram:0"));
    });
  });

  it("missing transcript for a durable row audits replay miss without throwing", async () => {
    await withFixture(async (ctx) => {
      const conversationId = "conv-claude" as ConversationId;
      await ctx.storage.putAccountRegistration(registration(CLAUDE, String(BOT)));
      await ctx.storage.upsertConversation(conversation(CLAUDE, String(BOT), conversationId));
      const entry = pendingEntry(CLAUDE, String(BOT), conversationId);
      await ctx.storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, 1000));

      const queue: PendingInboundEntry[] = [];
      await assert.doesNotReject(async () => {
        await rehydratePendingInboundForScope({
          storage: ctx.storage,
          transcripts: ctx.transcripts,
          audit: ctx.audit,
          queue,
          project: PROJECT,
          agent: CLAUDE,
        });
      });

      assert.equal(queue.length, 0);
      const miss = ctx.audit.events.find((event) => event.kind === "durable_inbound_replay_miss");
      assert.ok(miss);
      assert.equal(miss.detail?.reason, "transcript_payload_missing");
      assert.equal((await listPendingRows(ctx.storage, CLAUDE)).length, 1);
    });
  });
});

class RecordingAuditStore {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

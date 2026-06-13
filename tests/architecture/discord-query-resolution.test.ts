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
  Conversation,
  ConversationId,
  FailureClassification,
  Message,
  MessageId,
  OutboundPayload,
  QueryId,
  QueryRecord,
  SendResult,
  Session,
  SessionId,
} from "../../packages/core-contracts/src/index.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { sessionFixture } from "./_session-fixture.js";

const DISCORD = "discord" as CommId;
const CLAUDE = "claude" as AgentId;
const BOT = "123456789012345678";
const CONV = "conversation-discord-1" as ConversationId;
const SESSION = "session-discord-1" as SessionId;
const BASE = Date.now();

function account(): AccountRegistration {
  return {
    schema_version: 1,
    project: "project-a",
    comm: DISCORD,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: `reg-${BOT}`,
    credentials_ref: "keyring://discord/main",
    created_at: 1,
    updated_at: 1,
  };
}

function session(): Session {
  return sessionFixture({
    session_id: SESSION,
    agent: CLAUDE,
    project: "project-a",
    most_recent_inbound_conversation_id: CONV,
  });
}

function conversation(): Conversation {
  return {
    schema_version: 1,
    project: "project-a",
    comm: DISCORD,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: `reg-${BOT}`,
    chat_native_id: "chan-1",
    thread_native_id: null,
    conversation_id: CONV,
    agent: CLAUDE,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_id: null,
    created_at: 1,
  };
}

function query(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    schema_version: 1,
    query_id: "q-1" as QueryId,
    agent: CLAUDE,
    session: SESSION,
    kind: "choice",
    prompt_text: "Pick one",
    created_at: BASE - 60_000,
    ttl_seconds: 3600,
    origin_chat_id: CONV,
    source_message_id: null,
    resolved_at: null,
    resolution: null,
    options_json: JSON.stringify(["Alpha", "Beta"]),
    ...overrides,
  };
}

class RecordingAdapter implements CommAdapter {
  readonly id = DISCORD;
  readonly accountId = BOT as AccountId;
  readonly allowedSenderIds: readonly string[] = [];
  readonly sent: Array<{ target: ChatRef; payload: OutboundPayload }> = [];
  private seq = 900;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onInbound(_handler: (msg: Message) => Promise<void>): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}
  async send(target: ChatRef, payload: OutboundPayload): Promise<SendResult> {
    this.sent.push({ target, payload });
    this.seq += 1;
    return { platform_message_id: String(this.seq), sent_at: 11_000 };
  }
  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure(_error: unknown): FailureClassification {
    return "transient";
  }
}

interface Harness {
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  bus: MessageBus;
  adapter: RecordingAdapter;
  bridge: ClaudeBridge;
  tryResolve(message: Message): Promise<boolean>;
}

async function makeHarness(dir: string): Promise<Harness> {
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  await storage.putAccountRegistration(account());
  await storage.upsertConversation(conversation());
  await storage.upsertSession(session());
  await storage.setSessionMostRecentInbound(SESSION, CONV);

  const adapter = new RecordingAdapter();
  const bus = new MessageBus({
    project: "project-a",
    storage,
    transcripts: { append: async () => {} } as never,
    audit: { append: async () => {} } as never,
    blobs: {} as never,
    comms: [adapter],
  });
  const bridge = new ClaudeBridge({
    storage,
    bus,
    pendingInbound: [],
  });
  bridge.attach([adapter]);
  const tryResolve = (message: Message) =>
    (bus as unknown as {
      tryResolveOpenQuery(c: Conversation, m: Message): Promise<boolean>;
    }).tryResolveOpenQuery(conversation(), message);
  return { storage, bus, adapter, bridge, tryResolve };
}

let messageSeq = 500;
function inbound(text: string, overrides: Partial<Message> = {}): Message {
  messageSeq += 1;
  return {
    schema_version: 1,
    message_id: `discord:${messageSeq}` as MessageId,
    chat: {
      comm: DISCORD,
      account: BOT as AccountId,
      chat_native_id: "chan-1",
    },
    sender: { id: "user-1", display_name: "user", isBot: false, isForeignBot: false },
    origin: { comm: DISCORD },
    text,
    hop_count: 0,
    received_at: 10_000,
    platform_message_id: String(messageSeq),
    ...overrides,
  };
}

registerTempDirCleanup();

describe("Discord query prompts + resolution", () => {
  it("opens a choice query through ClaudeBridge with discord originChat and html format", async () => {
    const dir = await makeTempDir("acb-discord-query-open-");
    const h = await makeHarness(dir);
    try {
      const result = await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "<b>Allow deploy?</b>",
        prompt_format: "html",
        kind: "choice",
        options: ["Yes", "No"],
      });

      assert.equal(h.adapter.sent.length, 1);
      assert.equal(h.adapter.sent[0]!.target.comm, DISCORD);
      assert.equal(h.adapter.sent[0]!.payload.format, "html");
      assert.match(String(h.adapter.sent[0]!.payload.text), /Allow deploy/);

      const stored = await h.storage.getQuery(result.query_id);
      assert.equal(stored?.source_message_id, "discord:901" as MessageId);
    } finally {
      await h.storage.close();
    }
  });

  it("resolves a single open choice query via bare digit reply", async () => {
    const dir = await makeTempDir("acb-discord-query-digit-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(
        query({ source_message_id: "discord:901" as MessageId }),
      );

      assert.equal(await h.tryResolve(inbound("1")), true);
      const resolved = await h.storage.getQuery("q-1" as QueryId);
      assert.ok(resolved?.resolved_at != null);
      assert.equal(resolved?.resolution?.selected_option_index, 0);
    } finally {
      await h.storage.close();
    }
  });

  it("resolves via reply-to the prompt message among multiple open queries", async () => {
    const dir = await makeTempDir("acb-discord-query-replyto-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(
        query({ query_id: "q-1" as QueryId, source_message_id: "discord:901" as MessageId }),
      );
      await h.storage.insertQuery(
        query({
          query_id: "q-2" as QueryId,
          created_at: BASE - 30_000,
          source_message_id: "discord:902" as MessageId,
        }),
      );

      assert.equal(
        await h.tryResolve(inbound("2", { reply_to: "discord:902" as MessageId })),
        true,
      );
      const q2 = await h.storage.getQuery("q-2" as QueryId);
      assert.ok(q2?.resolved_at != null);
      assert.equal(q2?.resolution?.selected_option_index, 1);
      assert.equal((await h.storage.getQuery("q-1" as QueryId))?.resolved_at, null);
    } finally {
      await h.storage.close();
    }
  });
});

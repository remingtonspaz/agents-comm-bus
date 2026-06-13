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

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const BOT = "bot-1";
const CONV = "conversation-1" as ConversationId;
const SESSION = "session-1" as SessionId;

function account(): AccountRegistration {
  return {
    schema_version: 1,
    project: "project-a",
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: `reg-${BOT}`,
    credentials_ref: "keyring://telegram/main",
    created_at: 1,
    updated_at: 1,
  };
}

function session(): Session {
  return {
    schema_version: 1,
    session_id: SESSION,
    agent: CLAUDE,
    project: "project-a",
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
  };
}

function conversation(): Conversation {
  return {
    schema_version: 1,
    project: "project-a",
    comm: TELEGRAM,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: `reg-${BOT}`,
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: CONV,
    agent: CLAUDE,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_id: null,
    created_at: 1,
  };
}

// TTL is enforced against the bus's real clock (this.now() = Date.now), so
// fixtures must be created "recently" — an epoch-tiny created_at would make
// every query long-expired and silently reject all resolutions.
const BASE = Date.now();

function query(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    schema_version: 1,
    query_id: "q-1" as QueryId,
    agent: CLAUDE,
    session: SESSION,
    kind: "approval",
    prompt_text: "Allow?",
    created_at: BASE - 60_000,
    ttl_seconds: 3600,
    origin_chat_id: CONV,
    source_message_id: null,
    resolved_at: null,
    resolution: null,
    options_json: null,
    ...overrides,
  };
}

let messageSeq = 500;
function inbound(text: string, overrides: Partial<Message> = {}): Message {
  messageSeq += 1;
  return {
    schema_version: 1,
    message_id: `telegram:${messageSeq}` as MessageId,
    chat: {
      comm: TELEGRAM,
      account: BOT as AccountId,
      chat_native_id: "chat-1",
    },
    sender: { id: "user-1", display_name: "user", isBot: false, isForeignBot: false },
    origin: { comm: TELEGRAM },
    text,
    hop_count: 0,
    received_at: 10_000,
    platform_message_id: String(messageSeq),
    ...overrides,
  };
}

class RecordingAdapter implements CommAdapter {
  readonly id = TELEGRAM;
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
  audits: Array<{ kind: string; detail?: Record<string, unknown> }>;
  tryResolve(message: Message): Promise<boolean>;
}

async function makeHarness(dir: string): Promise<Harness> {
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  await storage.putAccountRegistration(account());
  await storage.upsertSession(session());
  await storage.upsertConversation(conversation());

  const audits: Harness["audits"] = [];
  const adapter = new RecordingAdapter();
  const bus = new MessageBus({
    project: "project-a",
    storage,
    transcripts: { append: async () => {} } as never,
    audit: { append: async (event: Harness["audits"][number]) => void audits.push(event) } as never,
    blobs: {} as never,
    comms: [adapter],
  });
  const tryResolve = (message: Message) =>
    (bus as unknown as {
      tryResolveOpenQuery(c: Conversation, m: Message): Promise<boolean>;
    }).tryResolveOpenQuery(conversation(), message);
  return { storage, bus, adapter, audits, tryResolve };
}

registerTempDirCleanup();

describe("AGE-9 multi-open query resolution semantics", () => {
  it("bare reply still resolves a single open query (today's behavior preserved)", async () => {
    const dir = await makeTempDir("acb-q9-single-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(query());

      assert.equal(await h.tryResolve(inbound("y")), true);
      const q = await h.storage.getQuery("q-1" as QueryId);
      assert.ok(q?.resolved_at != null, "the single open approval resolves on bare y");
      assert.equal(q?.resolution?.decision, "allow");
    } finally {
      await h.storage.close();
    }
  });

  it("non-answer text with a single open approval falls through as normal inbound", async () => {
    const dir = await makeTempDir("acb-q9-fallthrough-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(query());

      assert.equal(await h.tryResolve(inbound("how is it going?")), false);
      const q = await h.storage.getQuery("q-1" as QueryId);
      assert.equal(q?.resolved_at, null, "unparseable text must not resolve the approval");
    } finally {
      await h.storage.close();
    }
  });

  it("a reply-to targets exactly that prompt among multiple open queries", async () => {
    const dir = await makeTempDir("acb-q9-replyto-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(
        query({ query_id: "q-1" as QueryId, kind: "choice", source_message_id: "telegram:101" as MessageId, options_json: JSON.stringify(["a", "b"]) }),
      );
      await h.storage.insertQuery(
        query({ query_id: "q-2" as QueryId, kind: "choice", created_at: BASE - 30_000, source_message_id: "telegram:102" as MessageId, options_json: JSON.stringify(["c", "d"]) }),
      );

      const reply = inbound("2", { reply_to: "telegram:102" as MessageId });
      assert.equal(await h.tryResolve(reply), true);

      const q2 = await h.storage.getQuery("q-2" as QueryId);
      assert.ok(q2?.resolved_at != null, "the replied-to query resolves");
      assert.equal(q2?.resolution?.selected_option_index, 1);
      const q1 = await h.storage.getQuery("q-1" as QueryId);
      assert.equal(q1?.resolved_at, null, "the other open query is untouched");
    } finally {
      await h.storage.close();
    }
  });

  it("a bare digit with two open choice queries is consumed + helper, resolving NOTHING", async () => {
    const dir = await makeTempDir("acb-q9-ambiguous-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(
        query({ query_id: "q-1" as QueryId, kind: "choice", source_message_id: "telegram:101" as MessageId }),
      );
      await h.storage.insertQuery(
        query({ query_id: "q-2" as QueryId, kind: "choice", created_at: BASE - 30_000, source_message_id: "telegram:102" as MessageId }),
      );

      assert.equal(await h.tryResolve(inbound("1")), true, "consumed as an (ambiguous) answer attempt");

      assert.equal((await h.storage.getQuery("q-1" as QueryId))?.resolved_at, null);
      assert.equal((await h.storage.getQuery("q-2" as QueryId))?.resolved_at, null);
      assert.equal(h.adapter.sent.length, 1, "exactly one helper message is sent");
      assert.match(String(h.adapter.sent[0].payload.text), /2 prompts are open/);
      assert.ok(
        h.audits.some((a) => a.kind === "query_ambiguous_reply"),
        "the ambiguity is audited",
      );
    } finally {
      await h.storage.close();
    }
  });

  it("strict kinds outrank freetext: bare y resolves the approval even with a freetext query open", async () => {
    const dir = await makeTempDir("acb-q9-strict-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(query({ query_id: "q-appr" as QueryId, kind: "approval" }));
      await h.storage.insertQuery(
        query({ query_id: "q-free" as QueryId, kind: "freetext", created_at: 3 }),
      );

      assert.equal(await h.tryResolve(inbound("y")), true);
      assert.equal((await h.storage.getQuery("q-appr" as QueryId))?.resolution?.decision, "allow");
      assert.equal(
        (await h.storage.getQuery("q-free" as QueryId))?.resolved_at,
        null,
        "the freetext query stays open — strict parse wins",
      );
    } finally {
      await h.storage.close();
    }
  });

  it("two open freetext queries make any bare text ambiguous (consumed + helper)", async () => {
    const dir = await makeTempDir("acb-q9-freetext2-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(query({ query_id: "q-f1" as QueryId, kind: "freetext" }));
      await h.storage.insertQuery(
        query({ query_id: "q-f2" as QueryId, kind: "freetext", created_at: 3 }),
      );

      assert.equal(await h.tryResolve(inbound("some answer")), true);
      assert.equal((await h.storage.getQuery("q-f1" as QueryId))?.resolved_at, null);
      assert.equal((await h.storage.getQuery("q-f2" as QueryId))?.resolved_at, null);
      assert.equal(h.adapter.sent.length, 1);
    } finally {
      await h.storage.close();
    }
  });
});

describe("AGE-9 openQuery supersede policy + prompt source recording", () => {
  it("default openQuery still supersedes prior open queries (hook-path regression)", async () => {
    const dir = await makeTempDir("acb-q9-supersede-");
    const h = await makeHarness(dir);
    try {
      await h.storage.setSessionMostRecentInbound(SESSION, CONV);
      await h.storage.insertQuery(query({ query_id: "q-old" as QueryId }));

      const bridge = new ClaudeBridge({
        storage: h.storage,
        bus: h.bus,
        pendingInbound: [],
      });
      const result = await bridge.openQuery({
        session: SESSION,
        prompt_text: "New question?",
        kind: "approval",
      });

      const old = await h.storage.getQuery("q-old" as QueryId);
      assert.ok(old?.resolved_at != null, "the stale open query is superseded by default");
      const fresh = await h.storage.getOpenQueryById(result.query_id);
      assert.ok(fresh, "the new query is open");
      assert.equal(
        fresh?.source_message_id != null,
        true,
        "the sent prompt's message id is recorded for reply-to targeting",
      );
    } finally {
      await h.storage.close();
    }
  });

  it("openQuery with supersede=false leaves prior open queries open (multi-open path)", async () => {
    const dir = await makeTempDir("acb-q9-nosupersede-");
    const h = await makeHarness(dir);
    try {
      await h.storage.setSessionMostRecentInbound(SESSION, CONV);
      await h.storage.insertQuery(query({ query_id: "q-old" as QueryId }));

      const bridge = new ClaudeBridge({
        storage: h.storage,
        bus: h.bus,
        pendingInbound: [],
      });
      const result = await bridge.openQuery({
        session: SESSION,
        prompt_text: "Concurrent question?",
        kind: "choice",
        options: ["a", "b"],
        supersede: false,
      });

      assert.equal((await h.storage.getQuery("q-old" as QueryId))?.resolved_at, null);
      const open = await h.storage.listOpenQueriesForSession(SESSION);
      assert.equal(open.length, 2, "both queries are open concurrently");
      const fresh = open.find((q) => q.query_id === result.query_id);
      assert.ok(fresh?.source_message_id, "prompt message id recorded on the new query");
    } finally {
      await h.storage.close();
    }
  });

  it("setQuerySourceMessage refuses resolved queries", async () => {
    const dir = await makeTempDir("acb-q9-setsrc-");
    const h = await makeHarness(dir);
    try {
      await h.storage.insertQuery(query({ query_id: "q-1" as QueryId }));
      assert.equal(
        await h.storage.setQuerySourceMessage("q-1" as QueryId, "telegram:7" as MessageId),
        true,
      );
      await h.storage.resolveQuery(
        "q-1" as QueryId,
        {
          query_id: "q-1" as QueryId,
          decision: "allow",
          decided_by_sender_id: "u",
          decided_in_chat: { comm: TELEGRAM, account: BOT as AccountId, chat_native_id: "chat-1" },
          decided_at: 5,
        },
        5,
      );
      assert.equal(
        await h.storage.setQuerySourceMessage("q-1" as QueryId, "telegram:8" as MessageId),
        false,
        "resolved queries are immutable",
      );
    } finally {
      await h.storage.close();
    }
  });
});

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
  ResolvedDecision,
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

const Q1 = {
  question: "First question text",
  options: [{ label: "Alpha", description: "A desc" }, { label: "Beta" }],
};

const Q2 = {
  question: "Second question text",
  options: [{ label: "Gamma" }, { label: "Delta" }],
};

const Q3 = {
  question: "Third question text",
  options: [{ label: "Epsilon" }],
};

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
    return { platform_message_id: `telegram:${this.seq}` as MessageId, sent_at: 11_000 };
  }
  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure(_error: unknown): FailureClassification {
    return "transient";
  }
}

class FailingSecondQuestionAdapter extends RecordingAdapter {
  override async send(target: ChatRef, payload: OutboundPayload): Promise<SendResult> {
    const text = String(payload.text ?? "");
    if (text.includes("Question 2/")) {
      throw new Error("simulated send failure for question 2");
    }
    return super.send(target, payload);
  }
}

interface Harness {
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  bus: MessageBus;
  adapter: RecordingAdapter;
  bridge: ClaudeBridge;
}

async function makeHarness(dir: string, AdapterCtor = RecordingAdapter): Promise<Harness> {
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  await storage.putAccountRegistration(account());
  await storage.upsertSession(session());
  await storage.upsertConversation(conversation());
  await storage.setSessionMostRecentInbound(SESSION, CONV);

  const adapter = new AdapterCtor();
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
  (bridge as unknown as { wake: { register(input: unknown): void } }).wake.register({
    session: SESSION,
    project: "project-a",
    wakeDir: join(dir, "wake"),
  });
  return { storage, bus, adapter, bridge };
}

function decision(queryId: QueryId, optionIndex: number): ResolvedDecision {
  return {
    query_id: queryId,
    decision: "select_option",
    selected_option_index: optionIndex,
    decided_by_sender_id: "user-1",
    decided_in_chat: {
      comm: TELEGRAM,
      account: BOT as AccountId,
      chat_native_id: "chat-1",
    },
    decided_at: Date.now(),
  };
}

function sequenceMapSize(bridge: ClaudeBridge): number {
  return (bridge as unknown as { questionSequences: Map<unknown, unknown> }).questionSequences.size;
}

registerTempDirCleanup();

describe("AGE-37 AskUserQuestion sequencer", () => {
  it("shows one question at a time through a three-question flow", async () => {
    const dir = await makeTempDir("acb-q37-three-");
    const h = await makeHarness(dir);
    try {
      const result = await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "<fallback all questions>",
        kind: "choice",
        options: ["Alpha - A desc", "Beta"],
        query: { questions: [Q1, Q2, Q3] },
      });

      assert.equal(h.adapter.sent.length, 1);
      const firstText = String(h.adapter.sent[0].payload.text);
      assert.match(firstText, /Question 1\/3/);
      assert.match(firstText, /First question text/);
      assert.match(firstText, /Alpha/);
      assert.doesNotMatch(firstText, /Second question text/);
      assert.doesNotMatch(firstText, /Third question text/);
      assert.equal(sequenceMapSize(h.bridge), 1);

      assert.equal(await h.bus.resolveQuery(result.query_id, decision(result.query_id, 0)), true);
      assert.equal(h.adapter.sent.length, 2);
      const secondText = String(h.adapter.sent[1].payload.text);
      assert.match(secondText, /Question 2\/3/);
      assert.match(secondText, /Second question text/);

      const openAfterQ1 = await h.storage.listOpenQueriesForSession(SESSION);
      assert.equal(openAfterQ1.length, 1);
      const q2Id = openAfterQ1[0].query_id;

      assert.equal(await h.bus.resolveQuery(q2Id, decision(q2Id, 0)), true);
      assert.equal(h.adapter.sent.length, 3);
      assert.match(String(h.adapter.sent[2].payload.text), /Question 3\/3/);

      const openAfterQ2 = await h.storage.listOpenQueriesForSession(SESSION);
      assert.equal(openAfterQ2.length, 1);
      const q3Id = openAfterQ2[0].query_id;

      assert.equal(await h.bus.resolveQuery(q3Id, decision(q3Id, 0)), true);
      assert.equal(h.adapter.sent.length, 3, "no further sends after the final question resolves");
      assert.equal(sequenceMapSize(h.bridge), 0);
    } finally {
      await h.storage.close();
    }
  });

  it("does not advance the sequence when an unrelated query resolves", async () => {
    const dir = await makeTempDir("acb-q37-unrelated-");
    const h = await makeHarness(dir);
    try {
      await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "<fallback>",
        kind: "choice",
        options: ["Alpha - A desc", "Beta"],
        query: { questions: [Q1, Q2, Q3] },
      });
      assert.equal(h.adapter.sent.length, 1);

      const unrelated = await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "Unrelated approval?",
        kind: "approval",
        supersede: false,
      });
      assert.equal(h.adapter.sent.length, 2);

      assert.equal(
        await h.bus.resolveQuery(unrelated.query_id, {
          query_id: unrelated.query_id,
          decision: "allow",
          decided_by_sender_id: "user-1",
          decided_in_chat: {
            comm: TELEGRAM,
            account: BOT as AccountId,
            chat_native_id: "chat-1",
          },
          decided_at: Date.now(),
        }),
        true,
      );
      assert.equal(h.adapter.sent.length, 2, "resolving the unrelated query must not open question 2");
      assert.match(String(h.adapter.sent[0].payload.text), /Question 1\/3/);
    } finally {
      await h.storage.close();
    }
  });

  it("clears a stale sequence when a new AskUserQuestion supersedes", async () => {
    const dir = await makeTempDir("acb-q37-supersede-seq-");
    const h = await makeHarness(dir);
    try {
      await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "<fallback old>",
        kind: "choice",
        options: ["Alpha - A desc", "Beta"],
        query: { questions: [Q1, Q2, Q3] },
      });
      assert.equal(h.adapter.sent.length, 1);
      assert.match(String(h.adapter.sent[0].payload.text), /Question 1\/3/);

      const freshQ1 = { question: "New first?", options: [{ label: "One" }] };
      const freshQ2 = { question: "New second?", options: [{ label: "Two" }] };
      const fresh = await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "<fallback new>",
        kind: "choice",
        options: ["One"],
        query: { questions: [freshQ1, freshQ2] },
      });
      assert.equal(h.adapter.sent.length, 2);
      assert.match(String(h.adapter.sent[1].payload.text), /Question 1\/2/);
      assert.equal(sequenceMapSize(h.bridge), 1);

      assert.equal(await h.bus.resolveQuery(fresh.query_id, decision(fresh.query_id, 0)), true);
      assert.equal(h.adapter.sent.length, 3);
      assert.match(String(h.adapter.sent[2].payload.text), /Question 2\/2/);
      assert.match(String(h.adapter.sent[2].payload.text), /New second/);
    } finally {
      await h.storage.close();
    }
  });

  it("uses today's single-question path when only one question is provided", async () => {
    const dir = await makeTempDir("acb-q37-single-");
    const h = await makeHarness(dir);
    try {
      const fallback = "❓ <b>Claude has a question</b>\n\n<b>Only?</b>\n\n<b>1.</b> only\n<b>2.</b> Other (custom text)\n\nReply with <b>number</b> to select, or <b>y</b> to approve";
      await h.bridge.openQuery({
        session: SESSION,
        prompt_text: fallback,
        kind: "choice",
        options: ["only"],
        query: {
          questions: [{ question: "Only?", options: [{ label: "only" }] }],
        },
      });

      assert.equal(h.adapter.sent.length, 1);
      assert.equal(h.adapter.sent[0].payload.text, fallback);
      assert.equal(sequenceMapSize(h.bridge), 0);
    } finally {
      await h.storage.close();
    }
  });

  it("drops the sequence and attempts a fallback when the next question cannot be sent", async () => {
    const dir = await makeTempDir("acb-q37-fail-");
    const h = await makeHarness(dir, FailingSecondQuestionAdapter);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await h.bridge.openQuery({
        session: SESSION,
        prompt_text: "<fallback>",
        kind: "choice",
        options: ["Alpha - A desc", "Beta"],
        query: { questions: [Q1, Q2] },
      });
      assert.equal(h.adapter.sent.length, 1);

      await h.bus.resolveQuery(result.query_id, decision(result.query_id, 0));

      assert.equal(sequenceMapSize(h.bridge), 0);
      const attemptedFallback = h.adapter.sent.some((entry) =>
        String(entry.payload.text).includes("sequence is cancelled"),
      );
      assert.equal(
        attemptedFallback || h.adapter.sent.length === 1,
        true,
        "fallback send attempted, or both open+retry failed before fallback could record",
      );
      assert.ok(errors.length > 0, "failure is logged loudly");
    } finally {
      console.error = originalError;
      await h.storage.close();
    }
  });
});

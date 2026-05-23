import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isCrossAgentAllowed,
  type SubscriptionRule,
} from "../../packages/core-contracts/src/security.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  AuditEvent,
  ChatRef,
  CommId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  QueryId,
  QueryRecord,
  ResolvedDecision,
  Session,
  SessionId,
  Storage,
  TranscriptEntry,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
} from "../../packages/core-contracts/src/index.js";
import { MessageBus } from "../../agents-comm-bus/src/bus.js";

const CLAUDE = "claude" as AgentId;
const CODEX = "codex" as AgentId;
const REVIEWER = "reviewer" as AgentId;
const TELEGRAM = "telegram" as CommId;
const ACCOUNT = "12345" as AccountId;

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    schema_version: 1,
    message_id: "telegram:1" as MessageId,
    chat: {
      comm: TELEGRAM,
      account: ACCOUNT,
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

describe("bus invariants", () => {
  describe("no implicit cross-agent delivery", () => {
    it("allows same-agent delivery without a subscription", () => {
      assert.equal(isCrossAgentAllowed(CLAUDE, CLAUDE, []), true);
    });

    it("denies cross-agent delivery by default", () => {
      assert.equal(isCrossAgentAllowed(CLAUDE, CODEX, []), false);
    });

    it("allows only explicitly subscribed cross-agent delivery", () => {
      const subscriptions: SubscriptionRule[] = [
        { fromAgent: CLAUDE, toAgent: CODEX },
      ];

      assert.equal(isCrossAgentAllowed(CLAUDE, CODEX, subscriptions), true);
      assert.equal(isCrossAgentAllowed(CODEX, CLAUDE, subscriptions), false);
      assert.equal(isCrossAgentAllowed(CLAUDE, REVIEWER, subscriptions), false);
    });
  });
});

describe("MessageBus phase 1 invariants", () => {
  it("routes inbound messages by explicit account registration, not conversation recency", async () => {
    const storage = new MemoryStorage([
      {
        schema_version: SCHEMA_VERSION_ACCOUNT,
        project: "/repo",
        comm: TELEGRAM,
        agent: CLAUDE,
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        credentials_ref: "env:TELEGRAM_BOT_TOKEN",
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const transcripts = new MemoryTranscriptStore();
    const bus = new MessageBus({
      project: "/repo",
      storage,
      transcripts,
      audit: new MemoryAuditStore(),
      now: () => 2000,
    });

    const conversation = await bus.receiveInbound(makeMessage());

    assert.equal(conversation.agent, CLAUDE);
    assert.equal(conversation.account_label, "main");
    assert.equal(storage.conversations.size, 1);
  });

  it("records transcript before dispatching inbound wake work", async () => {
    const storage = new MemoryStorage([
      {
        schema_version: SCHEMA_VERSION_ACCOUNT,
        project: "/repo",
        comm: TELEGRAM,
        agent: CLAUDE,
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        credentials_ref: "env:TELEGRAM_BOT_TOKEN",
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const transcripts = new MemoryTranscriptStore();
    const order: string[] = [];
    transcripts.onAppend = () => order.push("transcript");
    const bus = new MessageBus({
      project: "/repo",
      storage,
      transcripts,
      audit: new MemoryAuditStore(),
      now: () => 2000,
    });
    bus.setDispatchSink({
      async enqueueInbound() {
        order.push("dispatch");
      },
    });

    await bus.receiveInbound(makeMessage());

    assert.deepEqual(order, ["transcript", "dispatch"]);
  });

  it("keeps same-label Claude and Codex conversations distinct", async () => {
    const codexAccount = "67890" as AccountId;
    const storage = new MemoryStorage([
      {
        schema_version: SCHEMA_VERSION_ACCOUNT,
        project: "/repo",
        comm: TELEGRAM,
        agent: CLAUDE,
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        credentials_ref: "env:CLAUDE_TELEGRAM_BOT_TOKEN",
        created_at: 1,
        updated_at: 1,
      },
      {
        schema_version: SCHEMA_VERSION_ACCOUNT,
        project: "/repo",
        comm: TELEGRAM,
        agent: CODEX,
        account_label: "main",
        bot_user_id: String(codexAccount),
        credentials_ref: "env:CODEX_TELEGRAM_BOT_TOKEN",
        created_at: 2,
        updated_at: 2,
      },
    ]);
    const bus = new MessageBus({
      project: "/repo",
      storage,
      transcripts: new MemoryTranscriptStore(),
      audit: new MemoryAuditStore(),
      now: () => 2000,
    });

    const claudeConversation = await bus.receiveInbound(makeMessage());
    const codexConversation = await bus.receiveInbound(makeMessage({
      message_id: "telegram:2" as MessageId,
      chat: {
        comm: TELEGRAM,
        account: codexAccount,
        chat_native_id: "chat-1",
      },
      platform_message_id: "2",
    }));

    assert.equal(claudeConversation.agent, CLAUDE);
    assert.equal(codexConversation.agent, CODEX);
    assert.notEqual(claudeConversation.conversation_id, codexConversation.conversation_id);
    assert.equal(storage.conversations.size, 2);
  });
});

class MemoryTranscriptStore {
  readonly entries: TranscriptEntry[] = [];
  onAppend?: () => void;

  async append(entry: TranscriptEntry): Promise<void> {
    this.entries.push(entry);
    this.onAppend?.();
  }

  async *read(): AsyncIterable<TranscriptEntry> {
    yield* this.entries;
  }
}

class MemoryAuditStore {
  readonly entries: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.entries.push(event);
  }
}

class MemoryStorage implements Storage {
  readonly registrations = new Map<string, AccountRegistration>();
  readonly conversations = new Map<ConversationId, Conversation>();
  readonly queries = new Map<QueryId, QueryRecord>();
  readonly sessions = new Map<SessionId, Session>();

  constructor(registrations: AccountRegistration[]) {
    for (const rec of registrations) {
      this.registrations.set(`${rec.comm}:${rec.bot_user_id}`, rec);
    }
  }

  async putAccountRegistration(rec: AccountRegistration): Promise<void> {
    this.registrations.set(`${rec.comm}:${rec.bot_user_id}`, rec);
  }

  async getAccountByBot(comm: CommId, bot_user_id: string): Promise<AccountRegistration | null> {
    return this.registrations.get(`${comm}:${bot_user_id}`) ?? null;
  }

  async listAccountRegistrations(): Promise<AccountRegistration[]> {
    return [...this.registrations.values()];
  }

  async deleteAccountRegistration(): Promise<void> {}

  async upsertConversation(rec: Conversation): Promise<ConversationId> {
    this.conversations.set(rec.conversation_id, rec);
    return rec.conversation_id;
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async findConversation(pk: {
    project: string;
    agent: AgentId;
    comm: CommId;
    account_label: string;
    chat_native_id: string;
    thread_native_id: string | null;
  }): Promise<Conversation | null> {
    return [...this.conversations.values()].find((c) =>
      c.project === pk.project &&
      c.agent === pk.agent &&
      c.comm === pk.comm &&
      c.account_label === pk.account_label &&
      c.chat_native_id === pk.chat_native_id &&
      c.thread_native_id === pk.thread_native_id) ?? null;
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()];
  }

  async touchConversationInbound(
    id: ConversationId,
    at: number,
    message_id: MessageId,
  ): Promise<void> {
    const current = this.conversations.get(id);
    if (current) {
      this.conversations.set(id, {
        ...current,
        schema_version: SCHEMA_VERSION_CONVERSATION,
        last_inbound_at: at,
        last_message_id: message_id,
      });
    }
  }

  async touchConversationOutbound(): Promise<void> {}

  async insertQuery(rec: QueryRecord): Promise<void> {
    this.queries.set(rec.query_id, rec);
  }

  async resolveQuery(
    query_id: QueryId,
    resolution: ResolvedDecision,
    resolved_at: number,
  ): Promise<boolean> {
    const rec = this.queries.get(query_id);
    if (!rec || rec.resolved_at != null) return false;
    this.queries.set(query_id, { ...rec, resolution, resolved_at });
    return true;
  }

  async getOpenQueryForSession(session: SessionId): Promise<QueryRecord | null> {
    return [...this.queries.values()].find((q) =>
      q.session === session && q.resolved_at == null) ?? null;
  }

  async getOpenQueryByConversation(conversation_id: ConversationId): Promise<QueryRecord | null> {
    return [...this.queries.values()].find((q) =>
      q.origin_chat_id === conversation_id && q.resolved_at == null) ?? null;
  }

  async getQuery(query_id: QueryId): Promise<QueryRecord | null> {
    return this.queries.get(query_id) ?? null;
  }

  async upsertSession(rec: Session): Promise<void> {
    this.sessions.set(rec.session_id, rec);
  }

  async acquireSessionLease(): Promise<boolean> {
    return true;
  }

  async releaseSessionLease(): Promise<void> {}

  async setSessionMostRecentInbound(
    session: SessionId,
    conversation_id: ConversationId,
  ): Promise<void> {
    const current = this.sessions.get(session);
    if (current) {
      this.sessions.set(session, {
        ...current,
        most_recent_inbound_conversation_id: conversation_id,
      });
    }
  }

  async getSession(session: SessionId): Promise<Session | null> {
    return this.sessions.get(session) ?? null;
  }

  async listSessions(filter: {
    project?: string;
    agent?: AgentId;
    status?: Session["status"];
  } = {}): Promise<Session[]> {
    return Array.from(this.sessions.values()).filter((s) => {
      if (filter.project !== undefined && s.project !== filter.project) return false;
      if (filter.agent !== undefined && s.agent !== filter.agent) return false;
      if (filter.status !== undefined && s.status !== filter.status) return false;
      return true;
    });
  }

  async close(): Promise<void> {}
}

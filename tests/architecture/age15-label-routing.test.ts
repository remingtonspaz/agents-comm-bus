// AGE-15: comm_send_message must route by concrete bot_user_id, never by an
// account label. Labels (e.g. "main") are human metadata that Claude and Codex
// both reuse, so resolving them is ambiguous and mis-routes one agent's outbound
// onto the other's bot. These tests pin: labels are hard-rejected on explicit
// targets, the resolved sending account lands in the outbound_sent audit, the
// omitted-target session fallback still works, and list_conversations surfaces
// the bot id an agent must use.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  AccountId,
  AccountRegistration,
  AgentId,
  AuditEvent,
  ChatRef,
  CommAdapter,
  CommId,
  Conversation,
  ConversationId,
  MessageId,
  OutboundPayload,
  Session,
  SessionId,
  Storage,
  TranscriptEntry,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
} from "../../packages/core-contracts/src/index.js";
import { MessageBus } from "../../core-daemon/bus.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const CODEX = "codex" as AgentId;
const PROJECT = "/repo";
const CLAUDE_BOT = "8950482517";
const CODEX_BOT = "8988792099";

function reg(overrides: Partial<AccountRegistration>): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT,
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: CLAUDE_BOT,
    credentials_ref: "env:TELEGRAM_BOT_TOKEN",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

// Two agents, both registered under account_label="main" — the exact shape that
// made the label ambiguous in production.
function bothAgents(): AccountRegistration[] {
  return [
    reg({ agent: CLAUDE, bot_user_id: CLAUDE_BOT, credentials_ref: "env:CLAUDE_TOKEN" }),
    reg({ agent: CODEX, bot_user_id: CODEX_BOT, credentials_ref: "env:CODEX_TOKEN" }),
  ];
}

function makeBus(storage: FakeStorage, audit: AuditEvent[], comms: CommAdapter[] = []) {
  return new MessageBus({
    project: PROJECT,
    storage: storage as unknown as Storage,
    transcripts: { async append(_e: TranscriptEntry) {}, async *read() {} } as never,
    audit: { async append(e: AuditEvent) { audit.push(e); } },
    comms,
    now: () => 2000,
  });
}

describe("AGE-15 outbound routes by bot id, not account label", () => {
  it("rejects an account label as an explicit send target", async () => {
    const storage = new FakeStorage(bothAgents());
    const bus = makeBus(storage, [], [fakeComm(CLAUDE_BOT)]);

    await assert.rejects(
      () =>
        bus.send({
          session: "s" as SessionId,
          comm: TELEGRAM,
          payload: { text: "hi" },
          target: { comm: TELEGRAM, account: "main" as AccountId, chat_native_id: "chat-1" },
        }),
      (err: Error) => {
        assert.match(err.message, /not a registered bot id/i);
        assert.match(err.message, /labels like "main" are not accepted/i);
        return true;
      },
    );
  });

  it("accepts a concrete bot_user_id and records the resolved account in outbound_sent", async () => {
    const storage = new FakeStorage(bothAgents());
    const audit: AuditEvent[] = [];
    const comm = fakeComm(CODEX_BOT);
    const bus = makeBus(storage, audit, [comm]);

    const id = await bus.send({
      session: "s" as SessionId,
      comm: TELEGRAM,
      payload: { text: "hi" },
      target: { comm: TELEGRAM, account: CODEX_BOT as AccountId, chat_native_id: "chat-1" },
    });

    assert.equal(id, "telegram:1");
    assert.equal(comm.sent.length, 1, "the codex adapter (not claude) sent the message");
    const outbound = audit.find((e) => e.kind === "outbound_sent");
    assert.ok(outbound, "outbound_sent audit emitted");
    assert.equal(outbound!.detail?.account, CODEX_BOT, "resolved sending bot id recorded");
    assert.equal(outbound!.detail?.account_label, "main");
    assert.equal(outbound!.detail?.requested_account, CODEX_BOT);
    assert.equal(outbound!.agent, CODEX);
  });

  it("omitted target falls back to the session's most-recent inbound and resolves a bot id", async () => {
    const storage = new FakeStorage([reg({ agent: CODEX, bot_user_id: CODEX_BOT })]);
    const conversationId = "conv-1" as ConversationId;
    storage.conversations.set(conversationId, {
      schema_version: SCHEMA_VERSION_CONVERSATION,
      project: PROJECT,
      comm: TELEGRAM,
      account_label: "main",
      chat_native_id: "chat-1",
      thread_native_id: null,
      conversation_id: conversationId,
      agent: CODEX,
      last_inbound_at: 1,
      last_outbound_at: null,
      last_message_id: "telegram:0" as MessageId,
      created_at: 1,
    });
    storage.sessions.set("s" as SessionId, {
      session_id: "s" as SessionId,
      agent: CODEX,
      project: PROJECT,
      schema_version: 1,
      created_at: 1,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
      most_recent_inbound_conversation_id: conversationId,
      status: "active",
    } as Session);
    const audit: AuditEvent[] = [];
    const comm = fakeComm(CODEX_BOT);
    const bus = makeBus(storage, audit, [comm]);

    await bus.send({ session: "s" as SessionId, comm: TELEGRAM, payload: { text: "hi" } });

    assert.equal(comm.sent.length, 1);
    const outbound = audit.find((e) => e.kind === "outbound_sent");
    assert.equal(outbound!.detail?.account, CODEX_BOT);
    assert.equal(outbound!.detail?.requested_account, null, "no explicit target → requested_account null");
  });

  it("list_conversations surfaces the registration bot_user_id", async () => {
    const storage = new FakeStorage(bothAgents());
    const conversationId = "conv-1" as ConversationId;
    storage.conversations.set(conversationId, {
      schema_version: SCHEMA_VERSION_CONVERSATION,
      project: PROJECT,
      comm: TELEGRAM,
      account_label: "main",
      chat_native_id: "chat-1",
      thread_native_id: null,
      conversation_id: conversationId,
      agent: CODEX,
      last_inbound_at: 1,
      last_outbound_at: null,
      last_message_id: "telegram:0" as MessageId,
      created_at: 1,
    });
    const bus = makeBus(storage, []);

    const [conversation] = await bus.listConversations();
    assert.equal(conversation.bot_user_id, CODEX_BOT, "the CODEX conversation resolves to the CODEX bot, not Claude's");
  });
});

function fakeComm(accountId: string): CommAdapter & { sent: ChatRef[] } {
  const sent: ChatRef[] = [];
  return {
    id: TELEGRAM,
    accountId: accountId as AccountId,
    sent,
    onInbound() {},
    onConnectionState() {},
    async send(target: ChatRef, _payload: OutboundPayload, _key: string) {
      sent.push(target);
      return { platform_message_id: "1", sent_at: 2000 };
    },
    async start() {},
    async stop() {},
    reportPressure() {},
    classifyFailure() {
      return { retryable: false } as never;
    },
  } as unknown as CommAdapter & { sent: ChatRef[] };
}

class FakeStorage implements Partial<Storage> {
  readonly registrations: AccountRegistration[];
  readonly conversations = new Map<ConversationId, Conversation>();
  readonly sessions = new Map<SessionId, Session>();

  constructor(registrations: AccountRegistration[]) {
    this.registrations = registrations;
  }

  async getAccountByBot(comm: CommId, bot_user_id: string): Promise<AccountRegistration | null> {
    return (
      this.registrations.find((r) => r.comm === comm && r.bot_user_id === bot_user_id) ?? null
    );
  }

  async listAccountRegistrations(filter?: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  }): Promise<AccountRegistration[]> {
    return this.registrations.filter(
      (r) =>
        (filter?.project === undefined || r.project === filter.project) &&
        (filter?.comm === undefined || r.comm === filter.comm) &&
        (filter?.agent === undefined || r.agent === filter.agent),
    );
  }

  async findConversation(pk: {
    project: string;
    agent: AgentId;
    comm: CommId;
    account_label: string;
    chat_native_id: string;
    thread_native_id: string | null;
  }): Promise<Conversation | null> {
    return (
      [...this.conversations.values()].find(
        (c) =>
          c.project === pk.project &&
          c.agent === pk.agent &&
          c.comm === pk.comm &&
          c.account_label === pk.account_label &&
          c.chat_native_id === pk.chat_native_id &&
          c.thread_native_id === pk.thread_native_id,
      ) ?? null
    );
  }

  async upsertConversation(rec: Conversation): Promise<ConversationId> {
    this.conversations.set(rec.conversation_id, rec);
    return rec.conversation_id;
  }

  async getConversation(id: ConversationId): Promise<Conversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()];
  }

  async touchConversationOutbound(): Promise<void> {}

  async getSession(session: SessionId): Promise<Session | null> {
    return this.sessions.get(session) ?? null;
  }
}

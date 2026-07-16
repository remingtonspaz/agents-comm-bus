import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MessageBus } from "../../core-daemon/bus.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { ClaudeWakeRegistry } from "../../core-daemon/bridges/claude/wake.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { ensureCommsForSession } from "../../core-daemon/daemon.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import {
  parseAgentsCommLabels,
  registrationMatchesConversationScope,
  serializeAccountLabelScope,
} from "../../core-daemon/session-label-scope.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
  Conversation,
  ConversationId,
  MessageId,
  SessionId,
} from "../../packages/core-contracts/src/types.js";
import type { Session } from "../../packages/core-contracts/src/records/index.js";
import { SCHEMA_VERSION_ACCOUNT, SCHEMA_VERSION_SESSION } from "../../packages/core-contracts/src/types.js";
import { sessionFixture } from "./_session-fixture.js";

const TELEGRAM = "telegram" as CommId;
const DISCORD = "discord" as CommId;
const CLAUDE = "claude" as AgentId;
const PROJECT = normalizeProjectPath("project-a");

async function withStorage<T>(test: (storage: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-age72-"));
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  try {
    return await test(storage);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function scopeMain(): string {
  return serializeAccountLabelScope({ telegram: "main" })!;
}

function scopeSubagent(): string {
  return serializeAccountLabelScope({ discord: "subagent" })!;
}

function registration(
  comm: CommId,
  label: string,
  botId: string,
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT,
    comm,
    agent: CLAUDE,
    account_label: label,
    bot_user_id: botId,
    registration_id: `reg-${comm}-${botId}`,
    credentials_ref: "file:/tmp/token.json",
    created_at: 1,
    updated_at: 1,
  };
}

function sessionRow(
  id: string,
  account_label_scope: string | null = null,
): Session {
  return sessionFixture({
    session_id: id as SessionId,
    agent: CLAUDE,
    project: PROJECT,
    account_label_scope,
  });
}

class RecordingFactory {
  readonly commId: CommId;
  readonly created: string[] = [];

  constructor(commId: CommId) {
    this.commId = commId;
  }

  async resolveCredentials(): Promise<{ status: "ok"; credentials: Record<string, unknown> }> {
    return { status: "ok", credentials: {} };
  }

  create(_credentials: Record<string, unknown>, accountId: AccountId): CommAdapter {
    this.created.push(String(accountId));
    return {
      id: this.commId,
      accountId,
      allowedSenderIds: [],
      async start() {},
      async stop() {},
      onInbound() {},
      onConnectionState() {},
      async send() {
        return { platform_message_id: "1", sent_at: 1 };
      },
      reportPressure() {
        return { backlog: 0, rateLimited: false };
      },
      classifyFailure() {
        return "transient" as const;
      },
    };
  }
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    schema_version: 1,
    project: PROJECT,
    comm: TELEGRAM,
    account_label: "main",
    bot_user_id: "bot-main",
    registration_id: "reg-telegram-bot-main",
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: "conv-1" as ConversationId,
    agent: CLAUDE,
    last_inbound_at: 1,
    last_outbound_at: null,
    last_message_id: "telegram:1" as MessageId,
    created_at: 1,
    metadata: null,
    ...overrides,
  };
}

describe("AGE-72 AGENTS_COMM_LABELS parser", () => {
  it("returns null when unset", () => {
    assert.equal(parseAgentsCommLabels(undefined), null);
    assert.equal(parseAgentsCommLabels(""), null);
  });

  it("parses comma-separated comm:label pairs", () => {
    assert.deepEqual(parseAgentsCommLabels("discord:subagent,telegram:main"), {
      discord: "subagent",
      telegram: "main",
    });
  });

  it("rejects malformed entries", () => {
    assert.throws(() => parseAgentsCommLabels("telegram"), /malformed/);
    assert.throws(() => parseAgentsCommLabels("telegram:"), /malformed/);
    assert.throws(() => parseAgentsCommLabels("telegram:main,telegram:sub"), /more than once/);
  });

  it("does not treat unlisted comms as catch-all for a labeled session", () => {
    assert.equal(
      registrationMatchesConversationScope(scopeMain(), {
        comm: DISCORD,
        account_label: "subagent",
      }),
      false,
    );
  });
});

describe("AGE-72 session lease uniqueness", () => {
  it("allows two labeled same (agent, project) live leases", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(sessionRow("session-main", scopeMain()));
      await storage.upsertSession(sessionRow("session-sub", scopeSubagent()));

      assert.equal(await storage.acquireSessionLease("session-main" as SessionId, "conn-1", 10), true);
      assert.equal(await storage.acquireSessionLease("session-sub" as SessionId, "conn-2", 11), true);
    });
  });

  it("still refuses two unlabeled same (agent, project) live leases", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(sessionRow("session-1"));
      await storage.upsertSession(sessionRow("session-2"));

      assert.equal(await storage.acquireSessionLease("session-1" as SessionId, "conn-1", 10), true);
      assert.equal(await storage.acquireSessionLease("session-2" as SessionId, "conn-2", 11), false);
    });
  });
});

describe("AGE-72 ensureCommsForSession label filtering", () => {
  it("starts only registrations matching the session scope", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration(TELEGRAM, "main", "bot-main"));
      await storage.putAccountRegistration(registration(DISCORD, "subagent", "bot-sub"));
      const telegramFactory = new RecordingFactory(TELEGRAM);
      const discordFactory = new RecordingFactory(DISCORD);
      const blobs = new ContentAddressedBlobStore(join(tmpdir(), "blobs-age72"));
      const bus = new MessageBus({
        project: PROJECT,
        storage,
        transcripts: { append: async () => {} } as never,
        audit: { append: async () => {} } as never,
        blobs,
        comms: [],
      });

      await ensureCommsForSession({
        project: PROJECT,
        agent: CLAUDE,
        accountLabelScope: scopeMain(),
        factories: [telegramFactory, discordFactory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: tmpdir(),
        leaseArbiter: new CommLeaseArbiter({ stateRoot: tmpdir() }),
        inFlight: new Set(),
      });

      assert.deepEqual(telegramFactory.created, ["bot-main"]);
      assert.deepEqual(discordFactory.created, []);
    });
  });

  it("preserves unscoped behavior when accountLabelScope is null", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration(TELEGRAM, "main", "bot-main"));
      await storage.putAccountRegistration(registration(DISCORD, "subagent", "bot-sub"));
      const telegramFactory = new RecordingFactory(TELEGRAM);
      const discordFactory = new RecordingFactory(DISCORD);
      const blobs = new ContentAddressedBlobStore(join(tmpdir(), "blobs-age72b"));
      const bus = new MessageBus({
        project: PROJECT,
        storage,
        transcripts: { append: async () => {} } as never,
        audit: { append: async () => {} } as never,
        blobs,
        comms: [],
      });

      await ensureCommsForSession({
        project: PROJECT,
        agent: CLAUDE,
        factories: [telegramFactory, discordFactory],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: tmpdir(),
        leaseArbiter: new CommLeaseArbiter({ stateRoot: tmpdir() }),
        inFlight: new Set(),
      });

      assert.deepEqual(telegramFactory.created, ["bot-main"]);
      assert.deepEqual(discordFactory.created, ["bot-sub"]);
    });
  });
});

describe("AGE-72 drain ownership isolation", () => {
  it("scopes Claude drain to the session label", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration(TELEGRAM, "main", "bot-main"));
      await storage.putAccountRegistration(registration(DISCORD, "subagent", "bot-sub"));
      await storage.upsertSession({
        ...sessionRow("session-main", scopeMain()),
        lease_holder_connection_id: "conn",
        lease_acquired_at: 1,
      });

      const bridge = new ClaudeBridge({
        storage,
        bus: {} as never,
        pendingInbound: [
          {
            message: {
              message_id: "telegram:1" as MessageId,
              chat: { comm: TELEGRAM, account: "bot-main" as AccountId, chat_native_id: "1" },
              text: "main",
            } as never,
            conversation: conversation(),
          },
          {
            message: {
              message_id: "discord:1" as MessageId,
              chat: { comm: DISCORD, account: "bot-sub" as AccountId, chat_native_id: "2" },
              text: "sub",
            } as never,
            conversation: conversation({
              comm: DISCORD,
              account_label: "subagent",
              bot_user_id: "bot-sub",
            }),
          },
        ],
      });

      const drained = await bridge.drainPendingInbound("session-main" as SessionId);
      assert.equal(drained.length, 1);
      assert.equal(drained[0]?.message.chat.comm, TELEGRAM);
    });
  });
});

describe("AGE-72 wake and steer routing", () => {
  it("Claude wake chooses the labeled session and hydrates scope from storage", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession({
        ...sessionRow("session-main", scopeMain()),
        lease_holder_connection_id: "conn",
        lease_acquired_at: 1,
      });
      const registry = new ClaudeWakeRegistry(() => 99);
      registry.setStorage(storage);
      const match = await (registry as unknown as {
        hydrateLatestForProject: (
          project: string,
          c: Conversation,
        ) => Promise<{ session: SessionId; account_label_scope: string | null } | undefined>;
      }).hydrateLatestForProject(PROJECT, conversation());
      assert.equal(match?.session, "session-main");
      assert.equal(match?.account_label_scope, scopeMain());
    });
  });

  it("Codex inbound routes to the matching labeled session", async () => {
    await withStorage(async (storage) => {
      const codex = "codex" as AgentId;
      await storage.upsertSession({
        ...sessionFixture({
          session_id: "session-main" as SessionId,
          agent: codex,
          project: PROJECT,
          account_label_scope: scopeMain(),
        }),
        lease_holder_connection_id: "conn-main",
        lease_acquired_at: 1,
      });
      await storage.upsertSession({
        ...sessionFixture({
          session_id: "session-sub" as SessionId,
          agent: codex,
          project: PROJECT,
          account_label_scope: scopeSubagent(),
        }),
        lease_holder_connection_id: "conn-sub",
        lease_acquired_at: 2,
      });

      const bridge = new CodexBridge({
        storage,
        bus: { setResolveSink() {} } as never,
        pendingInbound: [],
        appServerClientFactory: () => ({
          steerTurn: async () => ({ ok: true, method: "steer" as const, threadId: "t1" }),
          startTurn: async () => ({ ok: true, method: "start" as const, threadId: "t1" }),
        }),
      });
      bridge.attach([]);

      const session = await (bridge as unknown as {
        resolveSessionForConversation: (c: Conversation) => Promise<SessionId | undefined>;
      }).resolveSessionForConversation({
        ...conversation(),
        agent: codex,
      });
      assert.equal(session, "session-main");
    });
  });

  it("Codex pending wake payload is scoped to the matching labeled session", async () => {
    await withStorage(async (storage) => {
      const codex = "codex" as AgentId;
      await storage.putAccountRegistration({
        ...registration(TELEGRAM, "main", "bot-main"),
        agent: codex,
      });
      await storage.putAccountRegistration({
        ...registration(DISCORD, "subagent", "bot-sub"),
        agent: codex,
      });
      await storage.upsertSession({
        ...sessionFixture({
          session_id: "session-main" as SessionId,
          agent: codex,
          project: PROJECT,
          account_label_scope: scopeMain(),
        }),
        lease_holder_connection_id: "conn-main",
        lease_acquired_at: 1,
      });

      const bridge = new CodexBridge({
        storage,
        bus: { setResolveSink() {} } as never,
        pendingInbound: [
          {
            message: {
              message_id: "telegram:1" as MessageId,
              chat: { comm: TELEGRAM, account: "bot-main" as AccountId, chat_native_id: "1" },
              text: "main",
            } as never,
            conversation: conversation({ agent: codex }),
          },
          {
            message: {
              message_id: "discord:1" as MessageId,
              chat: { comm: DISCORD, account: "bot-sub" as AccountId, chat_native_id: "2" },
              text: "sub",
            } as never,
            conversation: conversation({
              agent: codex,
              comm: DISCORD,
              account_label: "subagent",
              bot_user_id: "bot-sub",
            }),
          },
        ],
        appServerClientFactory: () => ({
          steerTurn: async () => ({ ok: true, method: "steer" as const, threadId: "t1" }),
          startTurn: async () => ({ ok: true, method: "start" as const, threadId: "t1" }),
        }),
      });

      const pending = await (bridge as unknown as {
        pendingInboundForConversation: (
          c: Conversation,
          s: SessionId,
        ) => Promise<Array<{ message: { message_id: MessageId } }>>;
      }).pendingInboundForConversation(
        { ...conversation(), agent: codex },
        "session-main" as SessionId,
      );

      assert.deepEqual(pending.map((entry) => entry.message.message_id), ["telegram:1"]);
    });
  });
});

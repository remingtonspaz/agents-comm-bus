import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import type {
  AccountRegistration,
  AuditEvent,
  Conversation,
  Message,
  Session,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
  SCHEMA_VERSION_MESSAGE,
  type AccountId,
  type AgentId,
  type CommId,
  type ConversationId,
  type MessageId,
  type SessionId,
} from "../../packages/core-contracts/src/types.js";

async function withStorage<T>(test: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-codex-owner-"));
  try {
    return await test(join(dir, "storage.db"));
  } finally {
    await removeTempDir(dir);
  }
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

describe("Codex session owner liveness", () => {
  it("releases the session lease when the recorded owner pid is gone", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      const bridge = new CodexBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        sessionOwnerCheckIntervalMs: 5,
        isProcessAlive: () => false,
      });

      const result = await bridge.registerSession({
        session: "codex-session" as SessionId,
        project: "project-a",
        owner_process_pid: 99999,
        owner_process_label: "codex",
      });
      assert.equal(result.ok, true);

      await new Promise((resolve) => setTimeout(resolve, 40));

      const session = await storage.getSession("codex-session" as SessionId);
      assert.equal(session?.lease_holder_connection_id, null);
      assert.equal(session?.lease_owner_process_pid, null);

      await storage.close();
    });
  });

  it("reclaims a dead same-project lease before registering a new session", async () => {
    await withStorage(async (dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      const staleSession = "stale-codex-session" as SessionId;
      const nextSession = "next-codex-session" as SessionId;
      const project = normalizeProjectPath("project-a");
      try {
        await storage.upsertSession(sessionRecord(staleSession, project));
        assert.equal(
          await storage.acquireSessionLease(staleSession, "stale-conn", 10, {
            process_pid: 99999,
            process_label: "codex",
          }),
          true,
        );
        await storage.upsertSession(sessionRecord(nextSession, project));

        const bridge = new CodexBridge({
          storage,
          bus: {} as never,
          pendingInbound: [],
          isProcessAlive: () => false,
        });

        const result = await bridge.registerSession({
          session: nextSession,
          project,
        });
        assert.equal(result.ok, true);

        const stale = await storage.getSession(staleSession);
        assert.equal(stale?.lease_holder_connection_id, null);
        assert.equal(stale?.lease_owner_process_pid, null);

        const next = await storage.getSession(nextSession);
        assert.match(next?.lease_holder_connection_id ?? "", /^codex:next-codex-session:/);
      } finally {
        await storage.close();
      }
    });
  });

  it("audits Codex wake attempts and app-server results", async () => {
    {
      const storage = new RecordingStorage([registrationRecord()]);
      const pendingInbound: PendingInboundEntry[] = [];
      const audit = new RecordingAuditStore();
      const fakeClient = new FakeCodexClient();
      const bridge = new CodexBridge({
        storage,
        bus: {} as never,
        audit,
        pendingInbound,
        appServerClientFactory: () => fakeClient,
      });

      const session = "codex-session" as SessionId;
      const socket = new FakeSocket();
      await bridge.registerSession({
        session,
        project: "project-a",
        app_server_url: "ws://127.0.0.1:4509",
      }, socket);

      const conversation = conversationRecord();
      pendingInbound.push({ message: messageRecord(), conversation });

      await bridge.onInboundConversation(conversation);

      assert.deepEqual(fakeClient.calls, [
        ["turn/steer", "thread-1"],
      ]);
      assert.equal(pendingInbound.length, 0);

      const attempt = audit.events.find((event) => event.kind === "agent_wake_attempt");
      assert.ok(attempt);
      assert.equal(attempt.session, session);
      assert.equal(attempt.conversation_id, conversation.conversation_id);
      assert.equal(attempt.detail?.app_server_url, "ws://127.0.0.1:4509");
      assert.deepEqual(attempt.detail?.pending_message_ids, ["telegram:1"]);

      const succeeded = audit.events.find((event) => event.kind === "agent_wake_succeeded");
      assert.ok(succeeded);
      assert.equal(succeeded.session, session);
      assert.equal(succeeded.detail?.method, "turn/steer");
      assert.equal(succeeded.detail?.thread_id, "thread-1");

      socket.close();
      await waitForLeaseRelease(storage, session);
      await storage.close();
    }
  });

  it("labels daemon-delivered inbound by comm in Codex wake prompts", async () => {
    const storage = new RecordingStorage([registrationRecord("discord")]);
    const pendingInbound: PendingInboundEntry[] = [];
    const fakeClient = new FakeCodexClient();
    const bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      appServerClientFactory: () => fakeClient,
    });

    const session = "codex-session" as SessionId;
    const socket = new FakeSocket();
    await bridge.registerSession({
      session,
      project: "project-a",
      app_server_url: "ws://127.0.0.1:4509",
    }, socket);

    const conversation = conversationRecord("discord");
    pendingInbound.push({ message: messageRecord("discord"), conversation });

    await bridge.onInboundConversation(conversation);

    assert.match(fakeClient.steerTexts[0] ?? "", /daemon-delivered Discord messages/);
    assert.match(fakeClient.steerTexts[0] ?? "", /Discord MCP tool/);
    assert.doesNotMatch(fakeClient.steerTexts[0] ?? "", /Telegram MCP tool/);

    socket.close();
    await waitForLeaseRelease(storage, session);
    await storage.close();
  });
});

async function waitForLeaseRelease(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  session: SessionId,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const record = await storage.getSession(session);
    if (record?.lease_holder_connection_id === null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PROJECT_A = normalizeProjectPath("project-a");

function sessionRecord(id: SessionId, project = PROJECT_A): Session {
  return {
    schema_version: 1,
    session_id: id,
    agent: "codex" as AgentId,
    project,
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

function registrationRecord(comm: CommId = "telegram" as CommId): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT_A,
    agent: "codex" as AgentId,
    comm,
    account_label: "main",
    bot_user_id: "bot-1",
    credentials_ref: "file:/dev/null",
    created_at: 1,
    updated_at: 1,
  };
}

function conversationRecord(comm: CommId = "telegram" as CommId): Conversation {
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: PROJECT_A,
    agent: "codex" as AgentId,
    comm,
    account_label: "main",
    bot_user_id: "bot-1",
    chat_native_id: "-100group",
    thread_native_id: null,
    conversation_id: "conv-test" as ConversationId,
    last_inbound_at: 10,
    last_outbound_at: null,
    last_message_id: `${comm}:1` as MessageId,
    created_at: 10,
  };
}

function messageRecord(comm: CommId = "telegram" as CommId): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: `${comm}:1` as MessageId,
    chat: {
      comm,
      account: "bot-1" as AccountId,
      chat_native_id: "-100group",
    },
    sender: {
      id: "user-1",
      display_name: "Satrio",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm },
    text: "group wake probe",
    attachments: [],
    platform_message_id: "1",
    hop_count: 0,
    received_at: 10,
  };
}

class RecordingAuditStore {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class RecordingStorage implements Partial<Storage> {
  private readonly sessions = new Map<SessionId, Session>();

  constructor(private readonly registrations: AccountRegistration[]) {}

  async listAccountRegistrations(): Promise<AccountRegistration[]> {
    return this.registrations;
  }

  async upsertSession(rec: Session): Promise<void> {
    this.sessions.set(rec.session_id, rec);
  }

  async acquireSessionLease(
    session: SessionId,
    connectionId: string,
    at: number,
  ): Promise<boolean> {
    const record = this.sessions.get(session);
    if (!record) return false;
    this.sessions.set(session, {
      ...record,
      lease_holder_connection_id: connectionId,
      lease_acquired_at: at,
    });
    return true;
  }

  async releaseSessionLease(session: SessionId, connectionId: string, at: number): Promise<void> {
    const record = this.sessions.get(session);
    if (!record || record.lease_holder_connection_id !== connectionId) return;
    this.sessions.set(session, {
      ...record,
      lease_holder_connection_id: null,
      lease_released_at: at,
    });
  }

  async setSessionMostRecentInbound(
    session: SessionId,
    conversationId: ConversationId,
  ): Promise<void> {
    const record = this.sessions.get(session);
    if (!record) return;
    this.sessions.set(session, {
      ...record,
      most_recent_inbound_conversation_id: conversationId,
    });
  }

  async acknowledgePendingInboundDeliveries(): Promise<void> {}

  async getSession(session: SessionId): Promise<Session | null> {
    return this.sessions.get(session) ?? null;
  }

  async close(): Promise<void> {}
}

class FakeCodexClient {
  readonly calls: Array<[string, string]> = [];
  readonly steerTexts: string[] = [];

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
    this.calls.push(["turn/start", threadId]);
    return {};
  }

  async steerTurn(threadId: string, text: string, _expectedTurnId: string): Promise<unknown> {
    this.calls.push(["turn/steer", threadId]);
    this.steerTexts.push(text);
    return {};
  }

  async wakeMostRecentThread(_text?: string): Promise<any> {
    await this.startTurn("thread-1");
    return { ok: true, threadId: "thread-1", method: "turn/start" };
  }

  async steerMostRecentThread(text = ""): Promise<any> {
    await this.steerTurn("thread-1", text, "turn-1");
    return { ok: true, threadId: "thread-1", method: "turn/steer" };
  }
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

import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import {
  CommLeaseArbiter,
  commLeasePath,
  type AgentLeaseProperties,
  type LeaseRecord,
  type SelfIdentity,
} from "../../core-daemon/runtime/comm-lease.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
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

const PROJECT = normalizeProjectPath("D:\\tmp\\project-a");
const LOCK_URL = "ws://127.0.0.1:4601";
const LOCK_THREAD = "thread-from-comm-lock";
const REGISTER_URL = "ws://127.0.0.1:4602";
const REGISTER_THREAD = "thread-from-registration";
const DAEMON_PID = 88001;

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "acb-inbound-lock-"));
}

function selfIdentity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    pid: DAEMON_PID,
    stateRoot: "/state/a",
    checkoutRoot: "/checkout/a",
    daemonBin: null,
    daemonVersion: "0.2.50",
    authorityRank: "main-dev",
    ...over,
  };
}

function codexLeaseProps(
  appServerUrl: string,
  threadId: string,
): AgentLeaseProperties {
  return { codex: { appServerUrl, threadId } };
}

class TrackingCodexClient {
  readonly targets: Array<{ threadId: string; expectedProject: string }> = [];
  listThreadsCalls = 0;
  startTurnCalls = 0;
  steerTurnCalls = 0;

  async call(): Promise<unknown> {
    return {};
  }

  async listThreads(): Promise<unknown> {
    this.listThreadsCalls += 1;
    return {
      data: [{
        id: LOCK_THREAD,
        cwd: PROJECT,
        status: { type: "active" },
      }],
    };
  }

  async listThreadTurns(): Promise<unknown> {
    return { data: [{ id: "turn-1", status: "inProgress" }] };
  }

  async startTurn(): Promise<unknown> {
    this.startTurnCalls += 1;
    return {};
  }

  async steerTurn(): Promise<unknown> {
    this.steerTurnCalls += 1;
    return {};
  }

  async validateRecordedTarget(target: { threadId: string; expectedProject: string }) {
    this.targets.push(target);
    return { ok: true as const, threadId: target.threadId, cwd: target.expectedProject };
  }

  async wakeRecordedTarget(target: { threadId: string; expectedProject: string }) {
    await this.validateRecordedTarget(target);
    await this.startTurn();
    return { ok: true as const, threadId: target.threadId, method: "turn/start" as const };
  }

  async steerRecordedTarget(target: { threadId: string; expectedProject: string }) {
    await this.validateRecordedTarget(target);
    await this.steerTurn();
    return { ok: true as const, threadId: target.threadId, method: "turn/steer" as const };
  }
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

  async acquireSessionLease(session: SessionId, connectionId: string, at: number): Promise<boolean> {
    const record = this.sessions.get(session);
    if (!record) return false;
    this.sessions.set(session, {
      ...record,
      lease_holder_connection_id: connectionId,
      lease_acquired_at: at,
    });
    return true;
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

  async getSession(session: SessionId): Promise<Session | null> {
    return this.sessions.get(session) ?? null;
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()];
  }

  async acknowledgePendingInboundDeliveries(): Promise<void> {}
  async close(): Promise<void> {}
}

function registration(): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT,
    agent: "codex" as AgentId,
    comm: "telegram" as CommId,
    account_label: "main",
    bot_user_id: "bot-1",
    credentials_ref: "file:/dev/null",
    created_at: 1,
    updated_at: 1,
  };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: PROJECT,
    agent: "codex" as AgentId,
    comm: "telegram" as CommId,
    account_label: "main",
    bot_user_id: "bot-1",
    chat_native_id: "-100group",
    thread_native_id: null,
    conversation_id: "conv-test" as ConversationId,
    last_inbound_at: 10,
    last_outbound_at: null,
    last_message_id: "telegram:1" as MessageId,
    created_at: 10,
    ...over,
  };
}

function message(): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: "telegram:1" as MessageId,
    chat: {
      comm: "telegram" as CommId,
      account: "bot-1" as AccountId,
      chat_native_id: "-100group",
    },
    sender: {
      id: "user-1",
      display_name: "Satrio",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm: "telegram" as CommId },
    text: "wake probe",
    attachments: [],
    platform_message_id: "1",
    hop_count: 0,
    received_at: 10,
  };
}

async function seedHeldLease(
  home: string,
  agentProperties: AgentLeaseProperties | undefined,
): Promise<CommLeaseArbiter> {
  const arbiter = new CommLeaseArbiter({
    self: selfIdentity(),
    lastIpcServedAt: () => 1,
    homeDir: home,
    isPidAlive: () => true,
    now: () => 1,
  });
  if (agentProperties) {
    arbiter.setDesiredAgentProperties("telegram", "bot-1", agentProperties);
  }
  assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
  return arbiter;
}

async function writeForeignLease(home: string, holderPid: number): Promise<void> {
  const leasePath = commLeasePath("telegram", "bot-1", home);
  const record: LeaseRecord = {
    comm_id: "telegram",
    resource_id: "bot-1",
    pid: holderPid,
    stateRoot: "/foreign",
    checkoutRoot: null,
    daemonBin: null,
    daemonVersion: "0.0.0",
    authorityRank: "worktree",
    acquiredAt: 1,
    renewedAt: 1,
    lastIpcServedAt: 1,
    agentProperties: codexLeaseProps(LOCK_URL, LOCK_THREAD),
  };
  await mkdir(path.dirname(leasePath), { recursive: true });
  await writeFile(leasePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

describe("AGE-100 Codex inbound comm-lock wake target", () => {
  it("uses the on-disk comm lock target even when registration/in-memory target differs", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, codexLeaseProps(LOCK_URL, LOCK_THREAD));
    const storage = new RecordingStorage([registration()]);
    const pendingInbound: PendingInboundEntry[] = [];
    const audit = new RecordingAuditStore();
    const client = new TrackingCodexClient();
    let clientFactoryUrl: string | undefined;
    const bridge = new CodexBridge({
      storage: storage as Storage,
      bus: {} as never,
      audit,
      pendingInbound,
      appServerClientFactory: (url) => {
        clientFactoryUrl = url;
        return client;
      },
      readHeldCommLease: (commId, resourceId) => arbiter.readHeldCommLease(commId, resourceId),
      sessionOwnerCheckIntervalMs: 2_147_483_647,
    });

    const session = "codex-session" as SessionId;
    await bridge.registerSession({
      session,
      project: PROJECT,
      app_server_url: REGISTER_URL,
      thread_id: REGISTER_THREAD,
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.deepEqual(client.targets, [{ threadId: LOCK_THREAD, expectedProject: PROJECT }]);
    assert.equal(clientFactoryUrl, LOCK_URL);
    assert.notEqual(clientFactoryUrl, REGISTER_URL);
    assert.equal(client.steerTurnCalls, 1);
    assert.equal(pendingInbound.length, 0);
    const attempt = audit.events.find((event) => event.kind === "agent_wake_attempt");
    assert.equal(attempt?.detail?.thread_id, LOCK_THREAD);
    assert.equal(attempt?.detail?.app_server_url, LOCK_URL);
    assert.equal(attempt?.detail?.wake_target_source, "comm_lease");
  });

  it("fails closed with probe_no_match when comm lock has no codex agentProperties", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const onDisk = JSON.parse(
      await readFile(commLeasePath("telegram", "bot-1", home), "utf8"),
    ) as LeaseRecord;
    assert.equal(onDisk.agentProperties, undefined);

    const storage = new RecordingStorage([registration()]);
    const pendingInbound: PendingInboundEntry[] = [];
    const audit = new RecordingAuditStore();
    const client = new TrackingCodexClient();
    const bridge = new CodexBridge({
      storage: storage as Storage,
      bus: {} as never,
      audit,
      pendingInbound,
      codexPortRange: { min: 4500, max: 4500 },
      appServerClientFactory: () => client,
      readHeldCommLease: (commId, resourceId) => arbiter.readHeldCommLease(commId, resourceId),
      persistHeldCommLeaseAgentProperties: (commId, resourceId, props) =>
        arbiter.persistAgentPropertiesIfHeld(commId, resourceId, props),
      sessionOwnerCheckIntervalMs: 2_147_483_647,
    });

    const session = "codex-session" as SessionId;
    await bridge.registerSession({
      session,
      project: PROJECT,
      app_server_url: REGISTER_URL,
      thread_id: REGISTER_THREAD,
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(client.steerTurnCalls, 0);
    assert.equal(client.startTurnCalls, 0);
    assert.equal(pendingInbound.length, 1);
    assert.ok(audit.events.some((event) => event.kind === "agent_wake_failed"));
    assert.ok(audit.events.some((event) => event.kind === "agent_wake_target_invalid"));
    const invalid = audit.events.find((event) => event.kind === "agent_wake_target_invalid");
    assert.equal(invalid?.detail?.reason, "probe_no_match");
    assert.equal(invalid?.detail?.repair_required, true);
    assert.equal(audit.events.some((event) => event.kind === "agent_wake_attempt"), false);
  });

  it("fails closed when the on-disk comm lock is held by another daemon pid", async () => {
    const home = await tempHome();
    await writeForeignLease(home, 77001);
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 1,
    });

    const storage = new RecordingStorage([registration()]);
    const pendingInbound: PendingInboundEntry[] = [];
    const audit = new RecordingAuditStore();
    const client = new TrackingCodexClient();
    const bridge = new CodexBridge({
      storage: storage as Storage,
      bus: {} as never,
      audit,
      pendingInbound,
      appServerClientFactory: () => client,
      readHeldCommLease: (commId, resourceId) => arbiter.readHeldCommLease(commId, resourceId),
      sessionOwnerCheckIntervalMs: 2_147_483_647,
    });

    const session = "codex-session" as SessionId;
    await bridge.registerSession({
      session,
      project: PROJECT,
      app_server_url: REGISTER_URL,
      thread_id: REGISTER_THREAD,
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(client.listThreadsCalls, 0);
    assert.equal(pendingInbound.length, 1);
    const invalid = audit.events.find((event) => event.kind === "agent_wake_target_invalid");
    assert.equal(invalid?.detail?.reason, "comm_lease_not-held-by-self");
    assert.equal(invalid?.detail?.repair_required, true);
  });
});

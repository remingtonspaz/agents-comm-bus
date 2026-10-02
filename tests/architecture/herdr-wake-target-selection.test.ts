import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { PiBridge } from "../../core-daemon/bridges/pi/bridge.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { handleHerdrRegisterPane } from "../../core-daemon/daemon.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import {
  HerdrClient,
  herdrSessionId,
  type HerdrIdentity,
} from "../../core-daemon/runtime/herdr.js";
import { createSessionOwnerLiveness } from "../../core-daemon/runtime/session-owner-liveness.js";
import { supersedeStaleSessionsOnHerdrRegister } from "../../core-daemon/runtime/wake-target-selection.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { sessionFixture } from "./_session-fixture.js";
import type {
  AccountRegistration,
  AuditEvent,
  Conversation,
  Message,
} from "../../packages/core-contracts/src/records/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
  SCHEMA_VERSION_MESSAGE,
  type AgentId,
  type CommId,
  type ConversationId,
  type MessageId,
  type SessionId,
} from "../../packages/core-contracts/src/types.js";

const DEAD_PID = 73_776;
const LIVE_PID = 88_001;

function identity(overrides: Partial<HerdrIdentity> = {}): HerdrIdentity {
  return {
    type: "herdr",
    agent: "claude" as AgentId,
    pane_id: "w1:p1",
    socket_path: "C:\\Users\\test\\AppData\\Roaming\\herdr\\herdr.sock",
    ...overrides,
  };
}

class FakeHerdrExec {
  readonly calls: Array<{ bin: string; args: string[] }> = [];
  agentKind = "claude";

  exec = async (
    bin: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    this.calls.push({ bin, args });
    if (args[0] === "agent" && args[1] === "get") {
      return {
        stdout: JSON.stringify({
          result: { agent: { pane_id: args[2], agent: this.agentKind } },
        }),
        stderr: "",
      };
    }
    return { stdout: JSON.stringify({ ok: true }), stderr: "" };
  };

  client(id: HerdrIdentity): HerdrClient {
    return new HerdrClient(id, { execFile: this.exec });
  }
}

class RecordingAudit {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function liveness() {
  return createSessionOwnerLiveness({
    isPidAlive: (pid) => pid !== DEAD_PID,
  });
}

async function withDb<T>(
  fn: (storage: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-wake-target-"));
  const storage = await openSqliteStorage(join(dir, "db.sqlite"));
  try {
    return await fn(storage);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function registration(project: string, agent: AgentId = "claude"): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: normalizeProjectPath(project),
    comm: "telegram" as CommId,
    agent,
    account_label: "main",
    bot_user_id: "bot-1",
    registration_id: "reg-bot-1",
    credentials_ref: "file:/tmp/token.json",
    activation: "lazy",
    created_at: 1,
    updated_at: 1,
  };
}

function conversation(project: string, agent: AgentId = "claude"): Conversation {
  const canonical = normalizeProjectPath(project);
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: canonical,
    comm: "telegram" as CommId,
    account_label: "main",
    bot_user_id: "bot-1",
    registration_id: "reg-bot-1",
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: "conv-1" as ConversationId,
    agent,
    last_inbound_at: 1,
    last_outbound_at: null,
    last_message_id: "telegram:1" as MessageId,
    created_at: 1,
    metadata: null,
  };
}

function message(): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: "telegram:1" as MessageId,
    chat: { comm: "telegram" as CommId, account: "bot-1", native_id: "chat-1" },
    sender: { id: "user-1", display_name: "Tester" },
    text: "hello from telegram",
    format: "plain",
    attachments: [],
    created_at: 1,
    metadata: null,
  };
}

describe("AGE-110 bug A wake target selection", () => {
  it("a. stale in-memory native row loses to storage herdr row on inbound", async () => {
    await withDb(async (storage) => {
      const project = normalizeProjectPath("D:/repo/wake-target-a");
      await storage.putAccountRegistration(registration(project));
      const staleWakeDir = join(tmpdir(), `wake-stale-${Date.now()}`);
      const staleSession = "claude_stale_dead" as SessionId;
      const fake = new FakeHerdrExec();
      const bridge = new ClaudeBridge({
        storage,
        bus: new MessageBus({
          project,
          storage,
          transcripts: { append: async () => {} } as never,
          audit: new RecordingAudit(),
          comms: [],
        }),
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
        sessionOwnerIsLive: liveness(),
      });
      await bridge.registerSession({
        session: staleSession,
        project,
        connection_id: "claude:stale",
        wake_dir: staleWakeDir,
        owner_process_pid: DEAD_PID,
        owner_process_label: "claude",
      });
      await storage.releaseSessionConnectionLeasePreservingOwner(
        staleSession,
        "claude:stale",
        Date.now(),
      );
      await handleHerdrRegisterPane(
        {
          project,
          agent: "claude",
          identity: identity(),
        },
        {
          storage,
          bridges: [{ agentId: "claude" as AgentId }],
          ensureCommsForSession: async () => ({ rehydrated: false }),
        },
      );
      const conv = conversation(project);
      await storage.upsertConversation(conv);
      await bridge.onInboundConversation(conv, message());
      assert.equal(
        fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"),
        true,
      );
      await assert.rejects(() => readFile(join(staleWakeDir, "trigger-enter"), "utf8"));
    });
  });

  it("b. herdr registration ends stale sibling; live and leased siblings stay active", async () => {
    await withDb(async (storage) => {
      const project = normalizeProjectPath("D:/repo/wake-target-b");
      const stale = "claude_stale" as SessionId;
      const live = "claude_live" as SessionId;
      const leased = "claude_leased" as SessionId;
      const now = Date.now();
      await storage.upsertSession(
        sessionFixture({
          session_id: stale,
          project,
          agent: "claude",
          lease_owner_process_pid: DEAD_PID,
          lease_owner_process_registered_at: now,
        }),
      );
      await storage.upsertSession(
        sessionFixture({
          session_id: live,
          project,
          agent: "claude",
          lease_owner_process_pid: LIVE_PID,
          lease_owner_process_registered_at: now,
        }),
      );
      await storage.upsertSession(
        sessionFixture({
          session_id: leased,
          project,
          agent: "claude",
          lease_holder_connection_id: "claude:leased-conn",
          lease_owner_process_pid: DEAD_PID,
          lease_owner_process_registered_at: now,
        }),
      );
      const herdrId = herdrSessionId(identity()) as SessionId;
      await storage.upsertSession(
        sessionFixture({ session_id: herdrId, project, agent: "claude" }),
      );
      await storage.setSessionWakeTarget(herdrId, identity(), null);
      const herdrRow = await storage.getSession(herdrId);
      assert.ok(herdrRow);
      await supersedeStaleSessionsOnHerdrRegister(storage, herdrRow, liveness());
      assert.equal((await storage.getSession(stale))?.status, "ended");
      assert.equal((await storage.getSession(live))?.status, "active");
      assert.equal((await storage.getSession(leased))?.status, "active");
    });
  });

  it("c. two native sessions: live owner wins over dead owner", async () => {
    await withDb(async (storage) => {
      const project = normalizeProjectPath("D:/repo/wake-target-c");
      const liveWakeDir = join(tmpdir(), `wake-live-${Date.now()}`);
      const deadWakeDir = join(tmpdir(), `wake-dead-dead-end-${Date.now()}`);
      const now = Date.now();
      const bridge = new ClaudeBridge({
        storage,
        bus: new MessageBus({
          project,
          storage,
          transcripts: { append: async () => {} } as never,
          audit: new RecordingAudit(),
          comms: [],
        }),
        pendingInbound: [],
        sessionOwnerIsLive: liveness(),
      });
      await storage.upsertSession(
        sessionFixture({
          session_id: "claude_dead" as SessionId,
          project,
          agent: "claude",
          lease_owner_process_pid: DEAD_PID,
          lease_owner_process_registered_at: now,
        }),
      );
      await bridge.registerSession({
        session: "claude_live" as SessionId,
        project,
        connection_id: "claude:live",
        wake_dir: liveWakeDir,
        owner_process_pid: LIVE_PID,
      });
      const conv = conversation(project);
      await storage.upsertConversation(conv);
      await bridge.onInboundConversation(conv, message());
      await readFile(join(liveWakeDir, "trigger-enter"), "utf8");
      await assert.rejects(() => readFile(join(deadWakeDir, "trigger-enter"), "utf8"));
    });
  });

  it("d. Codex stale route row loses to herdr storage row", async () => {
    await withDb(async (storage) => {
      const fake = new FakeHerdrExec();
      fake.agentKind = "codex";
      const fakeClient = {
        calls: [] as string[][],
        wakeOrSteer: async () => {
          fakeClient.calls.push(["wakeOrSteer"]);
          return { ok: true, method: "turn/steer" as const, threadId: "t1" };
        },
      };
      const project = "project-a";
      const bridge = new CodexBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
        appServerClientFactory: () => fakeClient as never,
        sessionOwnerIsLive: liveness(),
        readHeldCommLease: async () => ({
          ok: true,
          comm_id: "telegram" as CommId,
          resource_id: "bot-1",
          agentProperties: {
            codex: { appServerUrl: "ws://127.0.0.1:1", threadId: "t1" },
          },
        }),
      });
      const reg = { ...registration(project, "codex"), agent: "codex" as AgentId };
      await storage.putAccountRegistration(reg);
      await bridge.registerSession({
        session: "codex_stale" as SessionId,
        project,
        connection_id: "codex:stale",
        owner_process_pid: DEAD_PID,
      });
      await storage.releaseSessionConnectionLeasePreservingOwner(
        "codex_stale" as SessionId,
        "codex:stale",
        Date.now(),
      );
      await handleHerdrRegisterPane(
        {
          project,
          agent: "codex",
          identity: identity({ agent: "codex" as AgentId }),
        },
        {
          storage,
          bridges: [bridge],
          ensureCommsForSession: async () => ({ rehydrated: false }),
        },
      );
      const conv = {
        ...conversation(project, "codex"),
        registration_id: reg.registration_id,
      };
      await storage.upsertConversation(conv);
      await bridge.onInboundConversation(conv);
      assert.equal(fakeClient.calls.length, 0);
      assert.equal(
        fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"),
        true,
      );
    });
  });

  it("d. Pi stale row loses to herdr storage row", async () => {
    await withDb(async (storage) => {
      const fake = new FakeHerdrExec();
      fake.agentKind = "pi";
      const project = "project-a";
      const bridge = new PiBridge({
        storage,
        bus: {} as never,
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
        sessionOwnerIsLive: liveness(),
      });
      const reg = { ...registration(project, "pi"), agent: "pi" as AgentId };
      await storage.putAccountRegistration(reg);
      await bridge.registerSession({
        session: "pi_stale" as SessionId,
        project,
        connection_id: "pi:stale",
        host: { pid: DEAD_PID, label: "pi" },
      });
      await storage.releaseSessionConnectionLeasePreservingOwner(
        "pi_stale" as SessionId,
        "pi:stale",
        Date.now(),
      );
      await handleHerdrRegisterPane(
        {
          project,
          agent: "pi",
          identity: identity({ agent: "pi" as AgentId, pane_id: "w1:p9" }),
        },
        {
          storage,
          bridges: [bridge],
          ensureCommsForSession: async () => ({ rehydrated: false }),
        },
      );
      const conv = {
        ...conversation(project, "pi"),
        registration_id: reg.registration_id,
      };
      await storage.upsertConversation(conv);
      await bridge.onInboundConversation(conv, message());
      assert.equal(
        fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"),
        true,
      );
    });
  });

  it("e. successful herdr inbound wake audits agent_wake_succeeded", async () => {
    await withDb(async (storage) => {
      const audit = new RecordingAudit();
      const fake = new FakeHerdrExec();
      const project = "project-a";
      const bridge = new ClaudeBridge({
        storage,
        bus: new MessageBus({
          project,
          storage,
          transcripts: { append: async () => {} } as never,
          audit,
          comms: [],
        }),
        pendingInbound: [],
        audit,
        herdrClientFactory: (id) => fake.client(id),
        sessionOwnerIsLive: liveness(),
      });
      const herdrId = herdrSessionId(identity()) as SessionId;
      await storage.upsertSession(
        sessionFixture({
          session_id: herdrId,
          project,
          agent: "claude",
        }),
      );
      await storage.setSessionWakeTarget(herdrId, identity(), null);
      const conv = conversation(project);
      await storage.upsertConversation(conv);
      await bridge.onInboundConversation(conv, message());
      const successes = audit.events.filter((e) => e.kind === "agent_wake_succeeded");
      assert.equal(successes.length, 1);
      assert.equal(successes[0].detail?.strategy, "herdr");
      assert.equal(successes[0].detail?.path, "inbound_wake");
    });
  });
});

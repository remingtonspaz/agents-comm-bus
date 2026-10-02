import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { MessageBus } from "../../core-daemon/bus.js";
import {
  HerdrClient,
  herdrSessionId,
  normalizeHerdrSocketPath,
  type HerdrIdentity,
} from "../../core-daemon/runtime/herdr.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { sessionFixture } from "./_session-fixture.js";
import type {
  AccountRegistration,
  AuditEvent,
  Conversation,
  Message,
  Session,
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
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";

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

function testBus(storage: Awaited<ReturnType<typeof openSqliteStorage>>) {
  return new MessageBus({
    project: "project-a",
    storage,
    transcripts: { append: async () => {} } as never,
    audit: new RecordingAudit(),
    comms: [],
  });
}

async function withDb<T>(
  fn: (storage: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-herdr-"));
  const storage = await openSqliteStorage(join(dir, "db.sqlite"));
  try {
    return await fn(storage);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function registration(project = "project-a"): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project,
    comm: "telegram" as CommId,
    agent: "claude" as AgentId,
    account_label: "main",
    bot_user_id: "bot-1",
    registration_id: "reg-bot-1",
    credentials_ref: "file:/tmp/token.json",
    activation: "lazy",
    created_at: 1,
    updated_at: 1,
  };
}

function conversation(project = "project-a"): Conversation {
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project,
    comm: "telegram" as CommId,
    account_label: "main",
    bot_user_id: "bot-1",
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: "conv-1" as ConversationId,
    agent: "claude" as AgentId,
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

describe("herdr wake (AGE-110 phase 1)", () => {
  it("a. wake mode resolution: none → auto; global native; project auto overrides; clear removes row", async () => {
    await withDb(async (storage) => {
      assert.equal(await storage.getWakeMode("project-a", "claude" as AgentId), "auto");
      await storage.setWakeMode("", "claude" as AgentId, "native", 1);
      assert.equal(await storage.getWakeMode("project-a", "claude" as AgentId), "native");
      await storage.setWakeMode("project-a", "claude" as AgentId, "auto", 2);
      assert.equal(await storage.getWakeMode("project-a", "claude" as AgentId), "auto");
      await storage.clearWakeMode("project-a", "claude" as AgentId);
      assert.equal(await storage.getWakeMode("project-a", "claude" as AgentId), "native");
      await storage.clearWakeMode("", "claude" as AgentId);
      assert.equal(await storage.getWakeMode("project-a", "claude" as AgentId), "auto");
    });
  });

  it("b. Claude inbound with herdr identity + auto → agent prompt, no trigger-enter", async () => {
    await withDb(async (storage) => {
      await storage.putAccountRegistration(registration());
      const fake = new FakeHerdrExec();
      const wakeDir = join(tmpdir(), `wake-${Date.now()}`);
      const session = "session-claude" as SessionId;
      const bridge = new ClaudeBridge({
        storage,
        bus: testBus(storage),
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      await bridge.registerSession({
        session,
        project: "project-a",
        wake_dir: wakeDir,
        herdr_identity: identity(),
      });
      await bridge.onInboundConversation(conversation(), message());
      assert.equal(
        fake.calls.some((call) => call.args[0] === "agent" && call.args[1] === "prompt"),
        true,
      );
      await assert.rejects(() => readFile(join(wakeDir, "trigger-enter"), "utf8"));
    });
  });

  it("c. Claude inbound mode native → watcher trigger, herdr NOT called", async () => {
    await withDb(async (storage) => {
      await storage.setWakeMode("", "claude" as AgentId, "native", 1);
      const fake = new FakeHerdrExec();
      const wakeDir = join(tmpdir(), `wake-native-${Date.now()}`);
      const bridge = new ClaudeBridge({
        storage,
        bus: testBus(storage),
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      await bridge.registerSession({
        session: "session-claude" as SessionId,
        project: "project-a",
        wake_dir: wakeDir,
        herdr_identity: identity(),
      });
      await bridge.onInboundConversation(conversation(), message());
      assert.equal(fake.calls.length, 0);
      const trigger = await readFile(join(wakeDir, "trigger-enter"), "utf8");
      assert.ok(trigger.trim().length > 0);
    });
  });

  it("d. herdr validation fails + not strict → audit wake_delivery_failure and watcher trigger", async () => {
    await withDb(async (storage) => {
      const audit = new RecordingAudit();
      const fake = new FakeHerdrExec();
      fake.agentKind = "codex";
      const wakeDir = join(tmpdir(), `wake-fallback-${Date.now()}`);
      const bridge = new ClaudeBridge({
        storage,
        bus: testBus(storage),
        audit,
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      await bridge.registerSession({
        session: "session-claude" as SessionId,
        project: "project-a",
        wake_dir: wakeDir,
        herdr_identity: identity(),
      });
      await bridge.onInboundConversation(conversation(), message());
      const failure = audit.events.find((e) => e.kind === "wake_delivery_failure");
      assert.ok(failure);
      assert.equal(failure.detail?.strategy, "herdr");
      await readFile(join(wakeDir, "trigger-enter"), "utf8");
    });
  });

  it("e. herdr validation fails + wake_strict herdr → audit, NO trigger, NO fallback", async () => {
    await withDb(async (storage) => {
      const audit = new RecordingAudit();
      const fake = new FakeHerdrExec();
      fake.agentKind = "codex";
      const wakeDir = join(tmpdir(), `wake-strict-${Date.now()}`);
      const bridge = new ClaudeBridge({
        storage,
        bus: testBus(storage),
        audit,
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      await bridge.registerSession({
        session: "session-claude" as SessionId,
        project: "project-a",
        wake_dir: wakeDir,
        herdr_identity: identity(),
        wake_strict: "herdr",
      });
      await bridge.onInboundConversation(conversation(), message());
      assert.ok(audit.events.some((e) => e.kind === "wake_delivery_failure"));
      await assert.rejects(() => readFile(join(wakeDir, "trigger-enter"), "utf8"));
    });
  });

  it("f. Claude resolve sink: question digit → send-keys; permission y → send-text + enter", async () => {
    await withDb(async (storage) => {
      const fake = new FakeHerdrExec();
      const bus = testBus(storage);
      const bridge = new ClaudeBridge({
        storage,
        bus,
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      bridge.attach([]);
      const session = "session-claude" as SessionId;
      await storage.upsertSession(
        sessionFixture({
          session_id: session,
          agent: "claude" as AgentId,
          project: "project-a",
        }),
      );
      await storage.setSessionWakeTarget(session, identity(), null);
      const chat = {
        comm: "telegram" as CommId,
        account: "bot-1",
        native_id: "chat-1",
      };
      const now = Date.now();
      await storage.insertQuery({
        schema_version: 1,
        query_id: "q-1" as import("../../packages/core-contracts/src/types.js").QueryId,
        agent: "claude" as AgentId,
        session,
        kind: "choice",
        prompt_text: "pick",
        created_at: now,
        ttl_seconds: 3600,
        origin_chat_id: null,
        source_message_id: null,
        resolved_at: null,
        resolution: null,
        options_json: null,
      });
      await bus.resolveQuery("q-1" as import("../../packages/core-contracts/src/types.js").QueryId, {
        query_id: "q-1" as import("../../packages/core-contracts/src/types.js").QueryId,
        decision: "select_option",
        selected_option_index: 2,
        decided_by_sender_id: "user-1",
        decided_in_chat: chat,
        decided_at: now + 1,
      });
      assert.deepEqual(
        fake.calls
          .filter((c) => c.args[1] === "send-keys")
          .map((c) => c.args.slice(3)),
        [["3"]],
      );
      fake.calls.length = 0;
      await storage.insertQuery({
        schema_version: 1,
        query_id: "q-2" as import("../../packages/core-contracts/src/types.js").QueryId,
        agent: "claude" as AgentId,
        session,
        kind: "approval",
        prompt_text: "allow?",
        created_at: now,
        ttl_seconds: 3600,
        origin_chat_id: null,
        source_message_id: null,
        resolved_at: null,
        resolution: null,
        options_json: null,
      });
      await bus.resolveQuery("q-2" as import("../../packages/core-contracts/src/types.js").QueryId, {
        query_id: "q-2" as import("../../packages/core-contracts/src/types.js").QueryId,
        decision: "allow",
        decided_by_sender_id: "user-1",
        decided_in_chat: chat,
        decided_at: now + 2,
      });
      assert.ok(fake.calls.some((c) => c.args[0] === "pane" && c.args[1] === "send-text"));
      assert.ok(fake.calls.some((c) => c.args[1] === "send-keys" && c.args.includes("enter")));
    });
  });

  it("g. Codex inbound with herdr identity → agent prompt, no app-server, pending kept", async () => {
    await withDb(async (storage) => {
    const pendingInbound: PendingInboundEntry[] = [];
    const fake = new FakeHerdrExec();
    fake.agentKind = "codex";
    const fakeClient = { calls: [] as string[][], wakeOrSteer: async () => {
      fakeClient.calls.push(["wakeOrSteer"]);
      return { ok: true, method: "turn/steer" as const, threadId: "t1" };
    } };
    const bridge = new CodexBridge({
      storage,
      bus: {} as never,
      pendingInbound,
      herdrClientFactory: (id) => fake.client(id),
      appServerClientFactory: () => fakeClient as never,
      readHeldCommLease: async () => ({
        ok: true,
        comm_id: "telegram" as CommId,
        resource_id: "bot-1",
        agentProperties: { codex: { appServerUrl: "ws://127.0.0.1:1", threadId: "t1" } },
      }),
    });
    const session = "codex-session" as SessionId;
    const reg = { ...registration(), agent: "codex" as AgentId };
    await storage.putAccountRegistration(reg);
    await bridge.registerSession({
      session,
      project: "project-a",
      herdr_identity: identity({ agent: "codex" as AgentId }),
    });
    const conv = {
      ...conversation(),
      agent: "codex" as AgentId,
      registration_id: reg.registration_id,
    };
    await storage.upsertConversation(conv);
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);
    assert.equal(fakeClient.calls.length, 0);
    assert.equal(
      fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"),
      true,
    );
    assert.equal(pendingInbound.length, 1);
    });
  });

  it("h. upsertSession re-register without herdr params does not clobber wake identity", async () => {
    await withDb(async (storage) => {
      const session = "session-claude" as SessionId;
      await storage.upsertSession(
        sessionFixture({ session_id: session, agent: "claude" as AgentId, project: "project-a" }),
      );
      await storage.setSessionWakeTarget(session, identity(), null);
      await storage.upsertSession(
        sessionFixture({ session_id: session, agent: "claude" as AgentId, project: "project-a" }),
      );
      const row = await storage.getSession(session);
      assert.ok(row?.wake_identity);
    });
  });

  it("i. herdrSessionId is stable across socket path case on win32", () => {
    const id = identity({
      socket_path: "C:\\Users\\test\\AppData\\Roaming\\herdr\\herdr.sock",
    });
    const alt = identity({
      socket_path: "c:/users/test/appdata/roaming/herdr/herdr.sock",
    });
    assert.equal(herdrSessionId(id), herdrSessionId(alt));
    assert.match(herdrSessionId(id), /^herdr_[a-f0-9]{24}$/);
    assert.equal(
      normalizeHerdrSocketPath(id.socket_path),
      normalizeHerdrSocketPath(alt.socket_path),
    );
  });

  it("j. herdr wake survives daemon restart (new bridge + same storage)", async () => {
    await withDb(async (storage) => {
      const fake = new FakeHerdrExec();
      const wakeDir = join(tmpdir(), `wake-restart-${Date.now()}`);
      const first = new ClaudeBridge({
        storage,
        bus: testBus(storage),
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      await first.registerSession({
        session: "session-claude" as SessionId,
        project: "project-a",
        wake_dir: wakeDir,
        herdr_identity: identity(),
      });
      const second = new ClaudeBridge({
        storage,
        bus: testBus(storage),
        pendingInbound: [],
        herdrClientFactory: (id) => fake.client(id),
      });
      fake.calls.length = 0;
      await second.onInboundConversation(conversation(), message());
      assert.equal(
        fake.calls.some((c) => c.args[0] === "agent" && c.args[1] === "prompt"),
        true,
      );
    });
  });
});

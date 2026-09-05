import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import type { CodexAppServerClient } from "../../core-daemon/bridges/codex/app-server.js";
import { liveThreadsMatchingProject } from "../../core-daemon/bridges/codex/app-server.js";
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

const PROJECT = normalizeProjectPath("D:\\tmp\\age103-project");
const BOT = "bot-age103";
const DAEMON_PID = 91003;
const PROBE_RANGE = { min: 4500, max: 4502 };
const LOCK_URL = "ws://127.0.0.1:4601";
const LOCK_THREAD = "thread-lock";
const PROBE_URL = "ws://127.0.0.1:4500";
const PROBE_THREAD = "thread-probe";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "acb-age103-"));
}

function selfIdentity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    pid: DAEMON_PID,
    stateRoot: "/state/age103",
    checkoutRoot: "/checkout/age103",
    daemonBin: null,
    daemonVersion: "0.2.60",
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

function threadEntry(
  threadId: string,
  cwd: string,
  statusType: string,
): Record<string, unknown> {
  return {
    id: threadId,
    cwd,
    status: { type: statusType },
  };
}

type PortBehavior =
  | { kind: "threads"; threads: unknown[] }
  | { kind: "reject" }
  | {
      kind: "custom";
      validateRecordedTarget?: CodexAppServerClient["validateRecordedTarget"];
      startTurn?: CodexAppServerClient["startTurn"];
      steerTurn?: CodexAppServerClient["steerTurn"];
      listThreads?: CodexAppServerClient["listThreads"];
      wakeRecordedTarget?: CodexAppServerClient["wakeRecordedTarget"];
      steerRecordedTarget?: CodexAppServerClient["steerRecordedTarget"];
    };

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
    bot_user_id: BOT,
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
    bot_user_id: BOT,
    chat_native_id: "-100group",
    thread_native_id: null,
    conversation_id: "conv-age103" as ConversationId,
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
      account: BOT as AccountId,
      chat_native_id: "-100group",
    },
    sender: {
      id: "user-1",
      display_name: "Satrio",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm: "telegram" as CommId },
    text: "probe me",
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
    arbiter.setDesiredAgentProperties("telegram", BOT, agentProperties);
  }
  assert.equal((await arbiter.tryAcquire("telegram", BOT)).ok, true);
  return arbiter;
}

async function writeForeignLease(home: string, holderPid: number): Promise<void> {
  const leasePath = commLeasePath("telegram", BOT, home);
  const record: LeaseRecord = {
    comm_id: "telegram",
    resource_id: BOT,
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

function createFakeClient(
  url: string,
  behaviors: Map<number, PortBehavior>,
  hooks: {
    onStartTurn?: (url: string) => Promise<void>;
    onSteerTurn?: (url: string) => Promise<void>;
  } = {},
): CodexAppServerClient {
  const port = Number(new URL(url).port);
  const behavior = behaviors.get(port) ?? { kind: "threads", threads: [] };

  if (behavior.kind === "custom") {
    const validateRecordedTarget = behavior.validateRecordedTarget
      ?? (async (target) => ({
        ok: true as const,
        threadId: target.threadId,
        cwd: target.expectedProject,
      }));
    return {
      call: async (method, params, options) => {
        if (method === "thread/list") {
          if (behavior.listThreads) return behavior.listThreads();
          return { data: [] };
        }
        if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "inProgress" }] };
        if (method === "turn/start") {
          await hooks.onStartTurn?.(url);
          if (behavior.startTurn) {
            return behavior.startTurn(
              String((params as { threadId?: string }).threadId ?? ""),
              "",
            );
          }
          return {};
        }
        if (method === "turn/steer") {
          await hooks.onSteerTurn?.(url);
          if (behavior.steerTurn) {
            return behavior.steerTurn(
              String((params as { threadId?: string }).threadId ?? ""),
              "",
              "turn-1",
            );
          }
          return {};
        }
        return {};
      },
      listThreads: behavior.listThreads ?? (async () => ({ data: [] })),
      listThreadTurns: async () => ({ data: [{ id: "turn-1", status: "inProgress" }] }),
      startTurn: async (threadId, text) => {
        await hooks.onStartTurn?.(url);
        if (behavior.startTurn) return behavior.startTurn(threadId, text);
        return {};
      },
      steerTurn: async (threadId, text, expectedTurnId) => {
        await hooks.onSteerTurn?.(url);
        if (behavior.steerTurn) return behavior.steerTurn(threadId, text, expectedTurnId);
        return {};
      },
      validateRecordedTarget,
      wakeRecordedTarget: behavior.wakeRecordedTarget
        ?? (async (target, text) => {
          const validated = await validateRecordedTarget(target);
          if (!validated.ok) return validated;
          await hooks.onStartTurn?.(url);
          if (behavior.startTurn) await behavior.startTurn(validated.threadId, text ?? ".");
          return { ok: true as const, threadId: validated.threadId, method: "turn/start" as const };
        }),
      steerRecordedTarget: behavior.steerRecordedTarget
        ?? (async (target, text) => {
          const validated = await validateRecordedTarget(target);
          if (!validated.ok) return validated;
          await hooks.onSteerTurn?.(url);
          if (behavior.steerTurn) await behavior.steerTurn(validated.threadId, text, "turn-1");
          return { ok: true as const, threadId: validated.threadId, method: "turn/steer" as const };
        }),
    };
  }

  const listResult = behavior.kind === "reject"
    ? null
    : { data: behavior.threads };

  return {
    call: async (method, _params, options) => {
      if (method === "thread/list") {
        if (behavior.kind === "reject") throw new Error("unreachable");
        return listResult;
      }
      if (method === "thread/turns/list") return { data: [{ id: "turn-1", status: "inProgress" }] };
      if (method === "turn/start") {
        await hooks.onStartTurn?.(url);
        return {};
      }
      if (method === "turn/steer") {
        await hooks.onSteerTurn?.(url);
        return {};
      }
      return {};
    },
    listThreads: async () => {
      if (behavior.kind === "reject") throw new Error("unreachable");
      return listResult;
    },
    listThreadTurns: async () => ({ data: [{ id: "turn-1", status: "inProgress" }] }),
    startTurn: async () => {
      await hooks.onStartTurn?.(url);
      return {};
    },
    steerTurn: async () => {
      await hooks.onSteerTurn?.(url);
      return {};
    },
    validateRecordedTarget: async (target) => {
      if (behavior.kind === "reject") {
        return {
          ok: false as const,
          reason: "listThreads-failed" as const,
          error: "unreachable",
          threadId: target.threadId,
          url,
        };
      }
      const threads = listedThreadsForValidation(listResult);
      const match = threads.find((entry) => threadIdFromEntry(entry) === target.threadId);
      if (!match) {
        return {
          ok: false as const,
          reason: "recorded-thread-absent" as const,
          threadId: target.threadId,
        };
      }
      const statusType = statusTypeFromEntry(match);
      if (statusType !== "active" && statusType !== "idle") {
        return {
          ok: false as const,
          reason: "recorded-thread-not-live" as const,
          threadId: target.threadId,
        };
      }
      const cwd = cwdFromEntry(match);
      if (!cwd || normalizeProjectPath(cwd) !== normalizeProjectPath(target.expectedProject)) {
        return {
          ok: false as const,
          reason: "recorded-thread-wrong-project" as const,
          threadId: target.threadId,
        };
      }
      return { ok: true as const, threadId: target.threadId, cwd };
    },
    wakeRecordedTarget: async (target, text) => {
      const validated = await createFakeClient(url, behaviors, hooks).validateRecordedTarget(target);
      if (!validated.ok) return validated;
      await hooks.onStartTurn?.(url);
      return { ok: true as const, threadId: validated.threadId, method: "turn/start" as const };
    },
    steerRecordedTarget: async (target, text) => {
      const validated = await createFakeClient(url, behaviors, hooks).validateRecordedTarget(target);
      if (!validated.ok) return validated;
      await hooks.onSteerTurn?.(url);
      return { ok: true as const, threadId: validated.threadId, method: "turn/steer" as const };
    },
  };
}

async function buildBridge(input: {
  home: string;
  arbiter: CommLeaseArbiter;
  behaviors: Map<number, PortBehavior>;
  audit?: RecordingAuditStore;
  pendingInbound?: PendingInboundEntry[];
  hooks?: {
    onStartTurn?: (url: string) => Promise<void>;
    onSteerTurn?: (url: string) => Promise<void>;
  };
}): Promise<{
  bridge: CodexBridge;
  audit: RecordingAuditStore;
  pendingInbound: PendingInboundEntry[];
  factoryUrls: string[];
}> {
  const audit = input.audit ?? new RecordingAuditStore();
  const pendingInbound = input.pendingInbound ?? [];
  const factoryUrls: string[] = [];
  const bridge = new CodexBridge({
    storage: new RecordingStorage([registration()]) as Storage,
    bus: {} as never,
    audit,
    pendingInbound,
    codexPortRange: PROBE_RANGE,
    codexProbeTimeoutMs: 50,
    codexProbeConcurrency: 3,
    appServerClientFactory: (url) => {
      factoryUrls.push(url);
      return createFakeClient(url, input.behaviors, input.hooks ?? {});
    },
    readHeldCommLease: (commId, resourceId) =>
      input.arbiter.readHeldCommLease(commId, resourceId),
    persistHeldCommLeaseAgentProperties: (commId, resourceId, props) =>
      input.arbiter.persistAgentPropertiesIfHeld(commId, resourceId, props),
    sessionOwnerCheckIntervalMs: 2_147_483_647,
  });

  const session = "codex-age103" as SessionId;
  await bridge.registerSession({
    session,
    project: PROJECT,
    app_server_url: "ws://127.0.0.1:4999",
    thread_id: "unused-registration-thread",
  });

  return { bridge, audit, pendingInbound, factoryUrls };
}

describe("AGE-103 Codex cwd-probe fallback", () => {
  it("liveThreadsMatchingProject ignores notLoaded threads with matching cwd", () => {
    const matches = liveThreadsMatchingProject(
      {
        data: [
          threadEntry("live", PROJECT, "active"),
          threadEntry("skip", PROJECT, "notLoaded"),
        ],
      },
      PROJECT,
    );
    assert.deepEqual(matches, [{ threadId: "live", cwd: PROJECT }]);
  });

  it("persistAgentPropertiesIfHeld writes props when held and leaves file unchanged when not held", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const props = codexLeaseProps(PROBE_URL, PROBE_THREAD);
    const ok = await arbiter.persistAgentPropertiesIfHeld("telegram", BOT, props);
    assert.deepEqual(ok, { ok: true });
    const onDisk = JSON.parse(
      await readFile(commLeasePath("telegram", BOT, home), "utf8"),
    ) as LeaseRecord;
    assert.deepEqual(onDisk.agentProperties, props);

    const foreignPath = commLeasePath("telegram", "foreign-bot", home);
    await writeFile(
      foreignPath,
      `${JSON.stringify({
        comm_id: "telegram",
        resource_id: "foreign-bot",
        pid: 77001,
        stateRoot: "/foreign",
        checkoutRoot: null,
        daemonBin: null,
        daemonVersion: "0.0.0",
        authorityRank: "worktree",
        acquiredAt: 1,
        renewedAt: 1,
        lastIpcServedAt: 1,
      } satisfies LeaseRecord, null, 2)}\n`,
      "utf8",
    );
    const before = await readFile(foreignPath, "utf8");
    const denied = await arbiter.persistAgentPropertiesIfHeld(
      "telegram",
      "foreign-bot",
      props,
    );
    assert.deepEqual(denied, { ok: false, reason: "not-held" });
    assert.equal(await readFile(foreignPath, "utf8"), before);
  });

  it("wakes with a single cwd match and persists lock props before turn/start", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [threadEntry(PROBE_THREAD, PROJECT, "active")] }],
      [4501, { kind: "reject" }],
      [4502, { kind: "threads", threads: [] }],
    ]);
    let lockAtTurn: AgentLeaseProperties | undefined;
    const { bridge, audit, pendingInbound, factoryUrls } = await buildBridge({
      home,
      arbiter,
      behaviors,
      hooks: {
        onSteerTurn: async () => {
          const onDisk = JSON.parse(
            await readFile(commLeasePath("telegram", BOT, home), "utf8"),
          ) as LeaseRecord;
          lockAtTurn = onDisk.agentProperties;
        },
      },
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.deepEqual(lockAtTurn, codexLeaseProps(PROBE_URL, PROBE_THREAD));
    assert.equal(pendingInbound.length, 0);
    const attempt = audit.events.find((event) => event.kind === "agent_wake_attempt");
    assert.equal(attempt?.detail?.wake_target_source, "cwd_probe");
    assert.equal(attempt?.detail?.app_server_url, PROBE_URL);
    assert.equal(attempt?.detail?.thread_id, PROBE_THREAD);
    assert.ok(factoryUrls.includes(PROBE_URL));
  });

  it("fails closed with probe_no_match and retains pending inbound", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [] }],
      [4501, { kind: "reject" }],
      [4502, { kind: "threads", threads: [] }],
    ]);
    const { bridge, audit, pendingInbound } = await buildBridge({ home, arbiter, behaviors });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(pendingInbound.length, 1);
    const invalid = audit.events.find((event) => event.kind === "agent_wake_target_invalid");
    assert.equal(invalid?.detail?.reason, "probe_no_match");
    assert.equal(invalid?.detail?.probe_scanned, 3);
    assert.equal(audit.events.some((event) => event.kind === "agent_wake_attempt"), false);
  });

  it("fails closed with probe_ambiguous when two ports match the same cwd", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [threadEntry("t-a", PROJECT, "idle")] }],
      [4501, { kind: "threads", threads: [threadEntry("t-b", PROJECT, "active")] }],
      [4502, { kind: "threads", threads: [] }],
    ]);
    const { bridge, audit, pendingInbound } = await buildBridge({ home, arbiter, behaviors });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(pendingInbound.length, 1);
    const invalid = audit.events.find((event) => event.kind === "agent_wake_target_invalid");
    assert.equal(invalid?.detail?.reason, "probe_ambiguous");
    assert.equal(invalid?.detail?.probe_matches, 2);
    assert.deepEqual(invalid?.detail?.probe_ports, [4500, 4501]);
  });

  it("does not probe when the comm lock already has a valid binding", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, codexLeaseProps(LOCK_URL, LOCK_THREAD));
    const behaviors = new Map<number, PortBehavior>([
      [4601, { kind: "threads", threads: [threadEntry(LOCK_THREAD, PROJECT, "active")] }],
      [4500, { kind: "threads", threads: [threadEntry("would-probe", PROJECT, "active")] }],
      [4501, { kind: "threads", threads: [threadEntry("would-probe", PROJECT, "active")] }],
      [4502, { kind: "threads", threads: [threadEntry("would-probe", PROJECT, "active")] }],
    ]);
    const probePorts: string[] = [];
    const { bridge, pendingInbound, factoryUrls } = await buildBridge({
      home,
      arbiter,
      behaviors,
      hooks: {
        onSteerTurn: async (url) => {
          if (url.startsWith("ws://127.0.0.1:450")) probePorts.push(url);
        },
      },
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(pendingInbound.length, 0);
    assert.equal(probePorts.length, 0);
    assert.deepEqual([...new Set(factoryUrls.map((url) => new URL(url).port))], ["4601"]);
  });

  it("probes after recorded-thread-not-live and after listThreads-failed on the lock url", async () => {
    for (const scenario of ["recorded-thread-not-live", "listThreads-failed"] as const) {
      const home = await tempHome();
      const arbiter = await seedHeldLease(home, codexLeaseProps(LOCK_URL, LOCK_THREAD));
      const lockPort = 4601;
      const behaviors = new Map<number, PortBehavior>();
      if (scenario === "recorded-thread-not-live") {
        behaviors.set(lockPort, {
          kind: "custom",
          listThreads: async () => ({
            data: [threadEntry(LOCK_THREAD, PROJECT, "notLoaded")],
          }),
          validateRecordedTarget: async (target) => ({
            ok: false as const,
            reason: "recorded-thread-not-live" as const,
            threadId: target.threadId,
          }),
          steerRecordedTarget: async (target) => ({
            ok: false as const,
            reason: "recorded-thread-not-live" as const,
            threadId: target.threadId,
          }),
          wakeRecordedTarget: async (target) => ({
            ok: false as const,
            reason: "recorded-thread-not-live" as const,
            threadId: target.threadId,
          }),
        });
      } else {
        behaviors.set(lockPort, {
          kind: "custom",
          listThreads: async () => {
            throw new Error("dead port");
          },
          validateRecordedTarget: async (target) => ({
            ok: false as const,
            reason: "listThreads-failed" as const,
            error: "dead port",
            threadId: target.threadId,
            url: LOCK_URL,
          }),
          steerRecordedTarget: async (target) => ({
            ok: false as const,
            reason: "listThreads-failed" as const,
            error: "dead port",
            threadId: target.threadId,
            url: LOCK_URL,
          }),
          wakeRecordedTarget: async (target) => ({
            ok: false as const,
            reason: "listThreads-failed" as const,
            error: "dead port",
            threadId: target.threadId,
            url: LOCK_URL,
          }),
        });
      }
      behaviors.set(4500, {
        kind: "threads",
        threads: [threadEntry(PROBE_THREAD, PROJECT, "active")],
      });
      behaviors.set(4501, { kind: "reject" });
      behaviors.set(4502, { kind: "threads", threads: [] });

      const { bridge, audit, pendingInbound } = await buildBridge({ home, arbiter, behaviors });
      const conv = conversation({ conversation_id: `conv-${scenario}` as ConversationId });
      pendingInbound.push({ message: message(), conversation: conv });
      await bridge.onInboundConversation(conv);

      assert.equal(pendingInbound.length, 0, scenario);
      const attempt = audit.events.find(
        (event) =>
          event.kind === "agent_wake_attempt" &&
          event.detail?.wake_target_source === "cwd_probe",
      );
      assert.equal(attempt?.detail?.wake_target_source, "cwd_probe", scenario);
    }
  });

  it("does not probe when the comm lock is not held by self", async () => {
    const home = await tempHome();
    await writeForeignLease(home, 77001);
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity(),
      lastIpcServedAt: () => 1,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 1,
    });
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [threadEntry(PROBE_THREAD, PROJECT, "active")] }],
    ]);
    const { bridge, audit, pendingInbound, factoryUrls } = await buildBridge({
      home,
      arbiter,
      behaviors,
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(factoryUrls.length, 0);
    assert.equal(pendingInbound.length, 1);
    const invalid = audit.events.find((event) => event.kind === "agent_wake_target_invalid");
    assert.equal(invalid?.detail?.reason, "comm_lease_not-held-by-self");
  });

  it("does not probe after a turn operation failure on a validated target", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, codexLeaseProps(LOCK_URL, LOCK_THREAD));
    const behaviors = new Map<number, PortBehavior>([
      [4601, {
        kind: "custom",
        validateRecordedTarget: async (target) => ({
          ok: true as const,
          threadId: target.threadId,
          cwd: target.expectedProject,
        }),
        steerRecordedTarget: async (target) => ({
          ok: false as const,
          reason: "steerTurn-failed",
          error: "steer failed",
          threadId: target.threadId,
        }),
        wakeRecordedTarget: async (target) => ({
          ok: false as const,
          reason: "startTurn-failed",
          error: "start failed",
          threadId: target.threadId,
        }),
      }],
      [4500, { kind: "threads", threads: [threadEntry(PROBE_THREAD, PROJECT, "active")] }],
    ]);

    const { bridge, audit, pendingInbound, factoryUrls } = await buildBridge({
      home,
      arbiter,
      behaviors,
    });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(factoryUrls.length, 1);
    assert.equal(new URL(factoryUrls[0]!).hostname, "127.0.0.1");
    assert.equal(pendingInbound.length, 1);
    const failed = audit.events.find((event) => event.kind === "agent_wake_failed");
    assert.match(String(failed?.detail?.reason), /failed/);
    assert.equal(
      audit.events.some((event) => event.detail?.wake_target_source === "cwd_probe"),
      false,
    );
  });

  it("fails closed when probe persist loses the held lock", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [threadEntry(PROBE_THREAD, PROJECT, "active")] }],
      [4501, { kind: "reject" }],
      [4502, { kind: "threads", threads: [] }],
    ]);
    const { bridge, audit, pendingInbound } = await buildBridge({ home, arbiter, behaviors });

    const leasePath = commLeasePath("telegram", BOT, home);
    const originalPersist = arbiter.persistAgentPropertiesIfHeld.bind(arbiter);
    arbiter.persistAgentPropertiesIfHeld = async (commId, resourceId, props) => {
      const foreign: LeaseRecord = JSON.parse(await readFile(leasePath, "utf8")) as LeaseRecord;
      foreign.pid = 88088;
      await writeFile(leasePath, `${JSON.stringify(foreign, null, 2)}\n`, "utf8");
      return originalPersist(commId, resourceId, props);
    };

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(pendingInbound.length, 1);
    const invalid = audit.events.find((event) => event.kind === "agent_wake_target_invalid");
    assert.equal(invalid?.detail?.reason, "probe_persist_failed:not-held");
  });

  it("scans every port in the configured range on loopback only", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "reject" }],
      [4501, { kind: "reject" }],
      [4502, { kind: "reject" }],
    ]);
    const { bridge, pendingInbound, factoryUrls } = await buildBridge({ home, arbiter, behaviors });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(factoryUrls.length, 3);
    assert.deepEqual(
      [...new Set(factoryUrls.map((url) => new URL(url).hostname))],
      ["127.0.0.1"],
    );
    assert.deepEqual(
      factoryUrls.map((url) => Number(new URL(url).port)).sort((a, b) => a - b),
      [4500, 4501, 4502],
    );
  });

  it("single-flights concurrent inbound wake probes for the same comm+bot+project", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [threadEntry(PROBE_THREAD, PROJECT, "active")] }],
      [4501, { kind: "reject" }],
      [4502, { kind: "reject" }],
    ]);
    const { bridge, pendingInbound, factoryUrls } = await buildBridge({ home, arbiter, behaviors });
    const conv = conversation();

    pendingInbound.push({ message: message(), conversation: conv });
    pendingInbound.push({
      message: { ...message(), message_id: "telegram:2" as MessageId },
      conversation: { ...conv, conversation_id: "conv-2" as ConversationId },
    });

    await Promise.all([
      bridge.onInboundConversation(conv),
      bridge.onInboundConversation({ ...conv, conversation_id: "conv-2" as ConversationId }),
    ]);

    const scannedProbePorts = new Set(
      factoryUrls
        .map((url) => Number(new URL(url).port))
        .filter((port) => port >= PROBE_RANGE.min && port <= PROBE_RANGE.max),
    );
    assert.equal(scannedProbePorts.size, PROBE_RANGE.max - PROBE_RANGE.min + 1);
  });

  it("auto-recovers version-skew locks missing agentProperties via cwd probe", async () => {
    const home = await tempHome();
    const arbiter = await seedHeldLease(home, undefined);
    const onDisk = JSON.parse(
      await readFile(commLeasePath("telegram", BOT, home), "utf8"),
    ) as LeaseRecord;
    assert.equal(onDisk.agentProperties, undefined);

    const behaviors = new Map<number, PortBehavior>([
      [4500, { kind: "threads", threads: [threadEntry(PROBE_THREAD, PROJECT, "active")] }],
      [4501, { kind: "reject" }],
      [4502, { kind: "reject" }],
    ]);
    const { bridge, audit, pendingInbound } = await buildBridge({ home, arbiter, behaviors });

    const conv = conversation();
    pendingInbound.push({ message: message(), conversation: conv });
    await bridge.onInboundConversation(conv);

    assert.equal(pendingInbound.length, 0);
    const attempt = audit.events.find((event) => event.kind === "agent_wake_attempt");
    assert.equal(attempt?.detail?.wake_target_source, "cwd_probe");
    const after = JSON.parse(
      await readFile(commLeasePath("telegram", BOT, home), "utf8"),
    ) as LeaseRecord;
    assert.deepEqual(after.agentProperties, codexLeaseProps(PROBE_URL, PROBE_THREAD));
  });
});

function listedThreadsForValidation(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const candidate = record.data ?? record.threads ?? record.items ?? record.loaded;
  return Array.isArray(candidate) ? candidate : [];
}

function threadIdFromEntry(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record.threadId ?? record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function cwdFromEntry(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function statusTypeFromEntry(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as Record<string, unknown>).status;
  if (!status || typeof status !== "object") return null;
  const type = (status as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

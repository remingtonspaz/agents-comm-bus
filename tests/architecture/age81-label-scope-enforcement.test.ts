import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MessageBus } from "../../core-daemon/bus.js";
import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import {
  ClaudeWakeRegistry,
  claudeWakeDirForProject,
  hashProjectKey,
} from "../../core-daemon/bridges/claude/wake.js";
import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
import { PiBridge } from "../../core-daemon/bridges/pi/bridge.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import {
  filterRegistrationsForSession,
  serializeAccountLabelScope,
} from "../../core-daemon/session-label-scope.js";
import {
  createSessionOwnerLiveness,
  DEFAULT_SESSION_OWNER_RECENCY_MS,
} from "../../core-daemon/runtime/session-owner-liveness.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { resolveClaudeWakeDir } from "../../hosts/claude/hooks/wake-support.js";
import { accountLabelScopeFromEnvSafe } from "../../hosts/common/comm-labels.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommId,
  Conversation,
  ConversationId,
  MessageId,
  Session,
  SessionId,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_SESSION,
} from "../../packages/core-contracts/src/index.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";

const PROJECT = normalizeProjectPath("D:/work/age81-project");
const DISCORD = "discord" as CommId;
const CONSULTANT_SCOPE = serializeAccountLabelScope({
  discord: "CONSULTANT",
})!;
const MAIN_SCOPE = serializeAccountLabelScope({ discord: "main" })!;

async function withStorage<T>(
  test: (storage: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acb-age81-"));
  const storage = await openSqliteStorage(path.join(dir, "storage.db"));
  try {
    return await test(storage);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function sessionRow(
  id: string,
  agent: AgentId,
  scope: string | null,
  lease: string | null,
  recentConversation: ConversationId | null = null,
): Session {
  return {
    schema_version: SCHEMA_VERSION_SESSION,
    session_id: id as SessionId,
    agent,
    project: PROJECT,
    created_at: 1,
    lease_holder_connection_id: lease,
    lease_acquired_at: lease ? 1 : null,
    lease_released_at: lease ? null : 2,
    lease_owner_process_pid: null,
    lease_owner_process_label: null,
    lease_owner_process_registered_at: null,
    lease_owner_daemon_discovery_root: null,
    lease_owner_daemon_checkout_root: null,
    lease_owner_daemon_state_root: null,
    lease_owner_daemon_bin: null,
    lease_owner_daemon_authority_rank: null,
    most_recent_inbound_conversation_id: recentConversation,
    account_label_scope: scope,
    status: "active",
  };
}

function registration(
  agent: AgentId,
  label: string,
  bot: string,
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: `reg-${agent}-${label}`,
    project: PROJECT,
    agent,
    comm: DISCORD,
    account_label: label,
    bot_user_id: bot,
    credentials_ref: "file:/tmp/token.json",
    created_at: 1,
    updated_at: 1,
  };
}

function withOwner(
  session: Session,
  pid: number,
  registeredAt: number,
): Session {
  return {
    ...session,
    lease_holder_connection_id: null,
    lease_owner_process_pid: pid,
    lease_owner_process_label: "claude",
    lease_owner_process_registered_at: registeredAt,
  };
}

function conversation(
  agent: AgentId,
  label = "CONSULTANT",
  bot = "bot-consultant",
): Conversation {
  return {
    schema_version: 1,
    conversation_id: `conv-${agent}-${label}` as ConversationId,
    project: PROJECT,
    agent,
    comm: DISCORD,
    account_label: label,
    bot_user_id: bot,
    registration_id: `reg-${agent}-${label}`,
    chat_native_id: "chat-1",
    thread_native_id: null,
    last_inbound_at: 1,
    last_outbound_at: null,
    last_message_id: `discord:${agent}:${label}` as MessageId,
    created_at: 1,
    metadata: null,
  };
}

function pendingEntry(agent: AgentId): PendingInboundEntry {
  return {
    message: {
      message_id: `discord:${agent}:1` as MessageId,
      platform_message_id: "1",
      chat: {
        comm: DISCORD,
        account: "bot-consultant" as AccountId,
        chat_native_id: "chat-1",
      },
      sender: { id: "sender-1" },
      text: "consultant message",
      received_at: 1,
    },
    conversation: conversation(agent),
  };
}

function barrierStorage(storage: Storage, participants = 2): Storage {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Proxy(storage, {
    get(target, property) {
      if (property === "listSessions") {
        return async (...args: Parameters<Storage["listSessions"]>) => {
          const result = await target.listSessions(...args);
          arrivals += 1;
          if (arrivals === participants) release();
          await gate;
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe("AGE-81 scoped Claude wake transport", () => {
  it("keeps the null-scope wake path byte-identical and matches the hook", () => {
    const home = path.resolve("D:/home");
    const legacy = claudeWakeDirForProject(PROJECT, home);
    assert.equal(
      legacy,
      path.join(
        home,
        ".agents-comm-bus",
        "claude-wake",
        "sessions",
        `${path.basename(PROJECT)}-${hashProjectKey(PROJECT)}`,
      ),
    );
    assert.equal(
      resolveClaudeWakeDir(PROJECT, {}),
      claudeWakeDirForProject(PROJECT),
    );
  });

  it("derives distinct labeled dirs and hook/daemon paths match exactly", () => {
    const consultant = claudeWakeDirForProject(
      PROJECT,
      os.homedir(),
      CONSULTANT_SCOPE,
    );
    const main = claudeWakeDirForProject(PROJECT, os.homedir(), MAIN_SCOPE);
    assert.notEqual(consultant, main);
    assert.equal(
      resolveClaudeWakeDir(PROJECT, {
        AGENTS_COMM_LABELS: "discord:CONSULTANT",
      }),
      consultant,
    );
    assert.equal(consultant.includes("CONSULTANT"), false);
  });

  it("isolates trigger, seed, and response files between labeled sessions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "acb-age81-wake-"));
    const consultantDir = claudeWakeDirForProject(
      PROJECT,
      home,
      CONSULTANT_SCOPE,
    );
    const mainDir = claudeWakeDirForProject(PROJECT, home, MAIN_SCOPE);
    const registry = new ClaudeWakeRegistry(() => 123);
    registry.register({
      session: "claude-consultant" as SessionId,
      project: PROJECT,
      wakeDir: consultantDir,
      account_label_scope: CONSULTANT_SCOPE,
    });
    registry.register({
      session: "claude-main" as SessionId,
      project: PROJECT,
      wakeDir: mainDir,
      account_label_scope: MAIN_SCOPE,
    });

    try {
      assert.equal(
        await registry.wakeConversation(
          conversation("claude" as AgentId),
          {
            ...pendingEntry("claude" as AgentId).message,
            text: "consultant only",
          },
        ),
        true,
      );
      assert.equal(
        await registry.writeResponseForSession(
          "claude-consultant" as SessionId,
          { response: "y", prompt_type: "permission" },
        ),
        true,
      );
      assert.equal(
        await readFile(path.join(consultantDir, "wake-seed.txt"), "utf8"),
        "discord message from sender-1: consultant only",
      );
      assert.equal(
        await pathExists(path.join(consultantDir, "trigger-enter")),
        true,
      );
      assert.equal(
        await pathExists(path.join(consultantDir, "permission-response.json")),
        true,
      );
      assert.equal(await pathExists(path.join(mainDir, "wake-seed.txt")), false);
      assert.equal(
        await pathExists(path.join(mainDir, "trigger-enter")),
        false,
      );
      assert.equal(
        await pathExists(path.join(mainDir, "permission-response.json")),
        false,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("hydrates the scoped wake directory from persisted session scope", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(
        sessionRow(
          "claude-consultant",
          "claude" as AgentId,
          CONSULTANT_SCOPE,
          "conn-consultant",
        ),
      );
      const registry = new ClaudeWakeRegistry(() => 99);
      registry.setStorage(storage);
      const hydrated = await (registry as unknown as {
        hydrateLatestForProject: (
          project: string,
          conversation: Conversation,
        ) => Promise<{ wakeDir: string } | undefined>;
      }).hydrateLatestForProject(
        PROJECT,
        conversation("claude" as AgentId),
      );
      assert.equal(
        hydrated?.wakeDir,
        claudeWakeDirForProject(PROJECT, os.homedir(), CONSULTANT_SCOPE),
      );
    });
  });

  it("does not fall back to an unrelated scoped session after restart", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(
        sessionRow(
          "claude-main",
          "claude" as AgentId,
          MAIN_SCOPE,
          "conn-main",
        ),
      );
      const registry = new ClaudeWakeRegistry(() => 99);
      registry.setStorage(storage);
      assert.equal(
        await (registry as unknown as {
          hydrateLatestForProject: (
            project: string,
            conversation: Conversation,
          ) => Promise<unknown>;
        }).hydrateLatestForProject(
          PROJECT,
          conversation("claude" as AgentId),
        ),
        undefined,
      );
    });
  });

  it("keeps cold-registry wake working with multiple legacy unlabeled rows", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(
        sessionRow("claude-legacy-1", "claude" as AgentId, null, null),
      );
      await storage.upsertSession(
        sessionRow("claude-legacy-2", "claude" as AgentId, null, null),
      );
      const registry = new ClaudeWakeRegistry(() => 99);
      registry.setStorage(storage);
      const hydrated = await (registry as unknown as {
        hydrateLatestForProject: (
          project: string,
          conversation: Conversation,
        ) => Promise<{ wakeDir: string } | undefined>;
      }).hydrateLatestForProject(
        PROJECT,
        conversation("claude" as AgentId),
      );
      assert.equal(
        hydrated?.wakeDir,
        claudeWakeDirForProject(PROJECT),
      );
    });
  });

  it("ignores an unrelated stale labeled row when hydrating the legacy wake dir", async () => {
    await withStorage(async (storage) => {
      await storage.upsertSession(
        sessionRow("claude-legacy-1", "claude" as AgentId, null, null),
      );
      await storage.upsertSession(
        sessionRow("claude-legacy-2", "claude" as AgentId, null, null),
      );
      await storage.upsertSession(
        withOwner(
          sessionRow(
            "claude-stale-main",
            "claude" as AgentId,
            MAIN_SCOPE,
            null,
          ),
          9_999,
          1,
        ),
      );
      const registry = new ClaudeWakeRegistry(
        () => DEFAULT_SESSION_OWNER_RECENCY_MS + 2,
        createSessionOwnerLiveness({
          now: () => DEFAULT_SESSION_OWNER_RECENCY_MS + 2,
          isPidAlive: () => true,
        }),
      );
      registry.setStorage(storage);
      const hydrated = await (registry as unknown as {
        hydrateLatestForProject: (
          project: string,
          conversation: Conversation,
        ) => Promise<{ wakeDir: string } | undefined>;
      }).hydrateLatestForProject(
        PROJECT,
        conversation("claude" as AgentId),
      );
      assert.equal(
        hydrated?.wakeDir,
        claudeWakeDirForProject(PROJECT),
      );
    });
  });

  it("keeps malformed host scope alive but scope-inert and actionable", () => {
    const messages: string[] = [];
    const scope = accountLabelScopeFromEnvSafe(
      { AGENTS_COMM_LABELS: "discord" },
      (message) => messages.push(message),
    );
    assert.equal(scope, '{"__agents_comm_invalid__":"invalid"}');
    assert.match(messages[0] ?? "", /malformed AGENTS_COMM_LABELS="discord"/);
    assert.match(messages[0] ?? "", /scope-inert/);
    assert.doesNotThrow(() =>
      resolveClaudeWakeDir(PROJECT, { AGENTS_COMM_LABELS: "discord" }),
    );
    assert.notEqual(
      resolveClaudeWakeDir(PROJECT, { AGENTS_COMM_LABELS: "discord" }),
      claudeWakeDirForProject(PROJECT),
    );
  });

  it("keeps a corrupt persisted scope off the legacy wake dir without throwing", () => {
    const home = path.resolve("D:/home");
    let corruptDir = "";
    assert.doesNotThrow(() => {
      corruptDir = claudeWakeDirForProject(PROJECT, home, "{");
    });
    assert.notEqual(
      corruptDir,
      claudeWakeDirForProject(PROJECT, home, null),
    );
  });
});

describe("AGE-81 live-session ownership precedence", () => {
  it("reserves labeled registrations only while the labeled sibling is live", () => {
    const agent = "claude" as AgentId;
    const registrations = [
      registration(agent, "CONSULTANT", "bot-consultant"),
      registration(agent, "general", "bot-general"),
    ];
    const unlabeled = sessionRow("unlabeled", agent, null, "conn-u");
    const labeled = sessionRow(
      "labeled",
      agent,
      CONSULTANT_SCOPE,
      "conn-l",
    );
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, labeled],
      ).map((row) => row.account_label),
      ["general"],
    );
    const released = { ...labeled, lease_holder_connection_id: null };
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, released],
      ).map((row) => row.account_label),
      ["CONSULTANT", "general"],
    );
  });

  it("uses a recent preserved Claude owner after lease release, but not stale or dead owners", () => {
    const agent = "claude" as AgentId;
    const registrations = [
      registration(agent, "CONSULTANT", "bot-consultant"),
      registration(agent, "general", "bot-general"),
    ];
    const unlabeled = sessionRow("unlabeled", agent, null, null);
    const registeredAt = 1_000;
    const labeled = withOwner(
      sessionRow("labeled", agent, CONSULTANT_SCOPE, null),
      6_732,
      registeredAt,
    );
    const liveOwner = createSessionOwnerLiveness({
      now: () => registeredAt + 1,
      isPidAlive: (pid) => pid === 6_732,
    });
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, labeled],
        liveOwner,
      ).map((row) => row.account_label),
      ["general"],
    );

    const staleOwner = createSessionOwnerLiveness({
      now: () =>
        registeredAt + DEFAULT_SESSION_OWNER_RECENCY_MS + 1,
      isPidAlive: () => true,
    });
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, labeled],
        staleOwner,
      ).map((row) => row.account_label),
      ["CONSULTANT", "general"],
    );

    const deadOwner = createSessionOwnerLiveness({
      now: () => registeredAt + 1,
      isPidAlive: () => false,
    });
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        unlabeled,
        [unlabeled, labeled],
        deadOwner,
      ).map((row) => row.account_label),
      ["CONSULTANT", "general"],
    );
  });

  it("forces the real Claude lease-released owner race", async () => {
    await withStorage(async (realStorage) => {
      const agent = "claude" as AgentId;
      const registeredAt = 1_000;
      await realStorage.putAccountRegistration(
        registration(agent, "CONSULTANT", "bot-consultant"),
      );
      await realStorage.upsertConversation(conversation(agent));
      await realStorage.upsertSession(
        sessionRow("claude-unlabeled-idle", agent, null, null),
      );
      await realStorage.upsertSession(
        withOwner(
          sessionRow(
            "claude-consultant-idle",
            agent,
            CONSULTANT_SCOPE,
            null,
          ),
          6_732,
          registeredAt,
        ),
      );
      const storage = barrierStorage(realStorage);
      const queue = [pendingEntry(agent)];
      const bridge = new ClaudeBridge({
        storage,
        bus: {} as never,
        pendingInbound: queue,
        sessionOwnerIsLive: createSessionOwnerLiveness({
          now: () => registeredAt + 1,
          isPidAlive: (pid) => pid === 6_732,
        }),
      });

      const [unlabeled, labeled] = await Promise.all([
        bridge.drainPendingInbound(
          "claude-unlabeled-idle" as SessionId,
        ),
        bridge.drainPendingInbound(
          "claude-consultant-idle" as SessionId,
        ),
      ]);
      assert.equal(unlabeled.length, 0);
      assert.equal(labeled.length, 1);
    });
  });

  for (const agentName of ["claude", "codex", "pi"] as const) {
    it(`forces concurrent unlabeled/labeled drain race for ${agentName}`, async () => {
      await withStorage(async (realStorage) => {
        const agent = agentName as AgentId;
        await realStorage.putAccountRegistration(
          registration(agent, "CONSULTANT", "bot-consultant"),
        );
        await realStorage.upsertConversation(conversation(agent));
        await realStorage.upsertSession(
          sessionRow(`${agentName}-unlabeled`, agent, null, "conn-u"),
        );
        await realStorage.upsertSession(
          sessionRow(
            `${agentName}-consultant`,
            agent,
            CONSULTANT_SCOPE,
            "conn-l",
          ),
        );
        const storage = barrierStorage(realStorage);
        const queue = [pendingEntry(agent)];
        let unlabeled: PendingInboundEntry[];
        let labeled: PendingInboundEntry[];

        if (agentName === "claude") {
          const bridge = new ClaudeBridge({
            storage,
            bus: {} as never,
            pendingInbound: queue,
          });
          [unlabeled, labeled] = await Promise.all([
            bridge.drainPendingInbound(
              `${agentName}-unlabeled` as SessionId,
            ),
            bridge.drainPendingInbound(
              `${agentName}-consultant` as SessionId,
            ),
          ]);
        } else if (agentName === "codex") {
          const bridge = new CodexBridge({
            storage,
            bus: { setResolveSink() {} } as never,
            pendingInbound: queue,
          });
          [unlabeled, labeled] = await Promise.all([
            bridge.drainInbound({
              session: `${agentName}-unlabeled`,
            }),
            bridge.drainInbound({
              session: `${agentName}-consultant`,
            }),
          ]);
        } else {
          const bridge = new PiBridge({
            storage,
            bus: {} as never,
            pendingInbound: queue,
          });
          const [unlabeledResult, labeledResult] = await Promise.all([
            bridge.drainInbound({
              session: `${agentName}-unlabeled`,
            }),
            bridge.drainInbound({
              session: `${agentName}-consultant`,
            }),
          ]);
          unlabeled = unlabeledResult.messages;
          labeled = labeledResult.messages;
        }

        assert.equal(unlabeled.length, 0);
        assert.equal(labeled.length, 1);
        assert.equal(labeled[0]?.conversation.account_label, "CONSULTANT");
      });
    });
  }

  it("rejects an unlabeled no-target send claimed by a live labeled sibling", async () => {
    await withStorage(async (storage) => {
      const agent = "claude" as AgentId;
      const conv = conversation(agent);
      await storage.putAccountRegistration(
        registration(agent, "CONSULTANT", "bot-consultant"),
      );
      const conversationId = await storage.upsertConversation(conv);
      await storage.upsertSession(
        sessionRow(
          "unlabeled",
          agent,
          null,
          "conn-u",
          conversationId,
        ),
      );
      await storage.upsertSession(
        withOwner(
          sessionRow("labeled", agent, CONSULTANT_SCOPE, null),
          6_732,
          1_000,
        ),
      );
      const bus = new MessageBus({
        project: PROJECT,
        storage,
        transcripts: { append: async () => {} } as never,
        audit: { append: async () => {} } as never,
        blobs: new ContentAddressedBlobStore(
          path.join(os.tmpdir(), "acb-age81-blobs"),
        ),
        comms: [],
        sessionOwnerIsLive: createSessionOwnerLiveness({
          now: () => 1_001,
          isPidAlive: (pid) => pid === 6_732,
        }),
      });
      await assert.rejects(
        () =>
          (bus as unknown as {
            targetFromSession: (session: SessionId) => Promise<unknown>;
          }).targetFromSession("unlabeled" as SessionId),
        /does not own most-recent inbound/,
      );
    });
  });

  it("treats corrupt persisted scope as inert instead of crashing routing", () => {
    const agent = "claude" as AgentId;
    const registrations = [
      registration(agent, "CONSULTANT", "bot-consultant"),
    ];
    const corrupt = sessionRow("corrupt", agent, "{", "conn-corrupt");
    assert.doesNotThrow(() =>
      filterRegistrationsForSession(
        registrations,
        corrupt,
        [corrupt],
      ),
    );
    assert.deepEqual(
      filterRegistrationsForSession(
        registrations,
        corrupt,
        [corrupt],
      ),
      [],
    );
  });

  it("keeps unlabeled-only no-target routing backward compatible", async () => {
    await withStorage(async (storage) => {
      const agent = "claude" as AgentId;
      const conv = conversation(agent);
      await storage.putAccountRegistration(
        registration(agent, "CONSULTANT", "bot-consultant"),
      );
      const conversationId = await storage.upsertConversation(conv);
      await storage.upsertSession(
        sessionRow(
          "unlabeled",
          agent,
          null,
          "conn-u",
          conversationId,
        ),
      );
      const bus = new MessageBus({
        project: PROJECT,
        storage,
        transcripts: { append: async () => {} } as never,
        audit: { append: async () => {} } as never,
        blobs: new ContentAddressedBlobStore(
          path.join(os.tmpdir(), "acb-age81-blobs-legacy"),
        ),
        comms: [],
      });
      assert.deepEqual(
        await (bus as unknown as {
          targetFromSession: (session: SessionId) => Promise<unknown>;
        }).targetFromSession("unlabeled" as SessionId),
        {
          comm: DISCORD,
          account: "bot-consultant",
          chat_native_id: "chat-1",
          thread_native_id: undefined,
        },
      );
    });
  });
});

describe("AGE-81 Codex pre-registration bootstrap", () => {
  it("does not bootstrap unlabeled solely for a live labeled sibling registration", async () => {
    await withStorage(async (storage) => {
      const agent = "codex" as AgentId;
      await storage.putAccountRegistration(
        registration(agent, "CONSULTANT", "bot-consultant"),
      );
      await storage.upsertSession(
        sessionRow("codex-consultant", agent, CONSULTANT_SCOPE, "conn-l"),
      );
      const bridge = new CodexBridge({
        storage,
        bus: { setResolveSink() {} } as never,
        pendingInbound: [],
      });

      const unlabeled = await bridge.bootstrapStatus({ project: PROJECT });
      const labeled = await bridge.bootstrapStatus({
        project: PROJECT,
        account_label_scope: CONSULTANT_SCOPE,
      });

      assert.equal(unlabeled.has_account_registration, false);
      assert.equal(unlabeled.bootstrap_required, false);
      assert.equal(labeled.has_account_registration, true);
      assert.equal(labeled.bootstrap_required, true);
    });
  });
});

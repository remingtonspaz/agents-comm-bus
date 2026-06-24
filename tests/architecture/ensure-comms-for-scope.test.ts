import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import {
  ensureCommsForSession,
  handleEnsureCommsForScope,
} from "../../core-daemon/daemon.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { connectIpc } from "../../core-daemon/ipc/client.js";
import { startIpcServer } from "../../core-daemon/ipc/server.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import {
  DEFAULT_ENSURE_COMMS_SCOPE_TIMEOUT_MS,
  ensureCommsForScopeAtStartup,
  resolveMcpShimProject,
  runWithStartupEnsureTimeout,
} from "../../hosts/common/mcp-shim-shared.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
} from "../../packages/core-contracts/src/types.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;

registerTempDirCleanup();

function registration(project: string, botId: string): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: normalizeProjectPath(project),
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: botId,
    registration_id: `reg-${botId}`,
    credentials_ref: "file:/does/not/matter.json",
    bot_username: "test_bot",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
  };
}

class RecordingFactory {
  readonly commId = TELEGRAM;
  readonly created: string[] = [];
  readonly adapters = new Map<string, FakeAdapter>();

  async resolveCredentials(): Promise<{ status: "ok"; credentials: Record<string, unknown> }> {
    return { status: "ok", credentials: {} };
  }

  create(_credentials: Record<string, unknown>, accountId: AccountId): CommAdapter {
    this.created.push(String(accountId));
    const adapter = new FakeAdapter(accountId);
    this.adapters.set(String(accountId), adapter);
    return adapter;
  }
}

class FakeAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly allowedSenderIds: readonly string[] = [];
  startCount = 0;

  constructor(readonly accountId: AccountId) {}

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {}
  onInbound(): void {}
  onConnectionState(): void {}
  async send() {
    return { platform_message_id: "fake", sent_at: 1 };
  }
  reportPressure() {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure() {
    return "transient" as const;
  }
}

function makeArbiter(dir: string) {
  return new CommLeaseArbiter({
    self: {
      pid: process.pid,
      stateRoot: dir,
      checkoutRoot: null,
      daemonBin: null,
      daemonVersion: "0.0.0",
      authorityRank: "worktree",
    },
    lastIpcServedAt: () => 1,
    homeDir: dir,
  });
}

describe("AGE-53 ensure_comms_for_scope IPC", () => {
  it("calls ensure with canonical project + agent and returns ok", async () => {
    const calls: Array<{ project: string; agent: AgentId }> = [];
    const result = await handleEnsureCommsForScope(
      { project: "./proj-a", agent: "claude" },
      async (project, agent) => {
        calls.push({ project, agent });
      },
    );

    assert.deepEqual(result, {
      ok: true,
      project: normalizeProjectPath("./proj-a"),
      agent: "claude",
    });
    assert.deepEqual(calls, [{
      project: normalizeProjectPath("./proj-a"),
      agent: "claude",
    }]);
  });

  it("defaults agent to claude when omitted", async () => {
    const calls: Array<{ project: string; agent: AgentId }> = [];
    const result = await handleEnsureCommsForScope(
      { project: "proj-a" },
      async (project, agent) => {
        calls.push({ project, agent });
      },
    );

    assert.equal(result.agent, "claude");
    assert.deepEqual(calls, [{
      project: normalizeProjectPath("proj-a"),
      agent: "claude",
    }]);
  });

  it("fails loud when project is missing or blank", async () => {
    await assert.rejects(
      () => handleEnsureCommsForScope({}, async () => {}),
      /ensure_comms_for_scope requires params\.project/,
    );
    await assert.rejects(
      () => handleEnsureCommsForScope({ project: "   " }, async () => {}),
      /ensure_comms_for_scope requires params\.project/,
    );
  });

  it("brings adapters online without creating session rows", async () => {
    const dir = await makeTempDir("acb-age53-scope-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const transcripts = new JsonlTranscriptStore(dir);
    const audit = new JsonlAuditStore(dir);
    const blobs = new ContentAddressedBlobStore(dir);
    const bus = new MessageBus({ project: dir, storage, transcripts, audit, blobs, comms: [] });
    const factory = new RecordingFactory();
    const inFlight = new Set<string>();

    try {
      await storage.putAccountRegistration(registration("proj-a", "bot-a"));
      const sessionsBefore = await storage.listSessions();
      assert.equal(sessionsBefore.length, 0);

      const ensureFn = (project: string, agent: AgentId) =>
        ensureCommsForSession({
          project,
          agent,
          factories: [factory],
          bus,
          bridges: [],
          storage,
          env: {},
          blobs,
          stateRoot: dir,
          leaseArbiter: makeArbiter(dir),
          inFlight,
        });

      const result = await handleEnsureCommsForScope(
        { project: "proj-a", agent: "claude" },
        ensureFn,
      );

      assert.equal(result.ok, true);
      assert.ok(bus.getComm(TELEGRAM, "bot-a" as AccountId));
      assert.deepEqual(factory.created, ["bot-a"]);
      const sessionsAfter = await storage.listSessions();
      assert.equal(sessionsAfter.length, 0);
    } finally {
      await storage.close();
    }
  });

  it("dispatches through the IPC server handler", async () => {
    const calls: Array<{ project: string; agent: AgentId }> = [];
    const server = await startIpcServer({
      onRequest: async (request) => {
        if (request.method !== "ensure_comms_for_scope") {
          throw new Error(`unexpected method: ${request.method}`);
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        return handleEnsureCommsForScope(params, async (project, agent) => {
          calls.push({ project, agent });
        });
      },
    });

    try {
      const client = await connectIpc({
        port: server.port,
        clientVersion: "test",
        metadata: { test: "ensure-comms-for-scope" },
      });
      try {
        const result = await client.request("ensure_comms_for_scope", {
          project: "proj-b",
          agent: "claude",
        });
        assert.deepEqual(result, {
          ok: true,
          project: normalizeProjectPath("proj-b"),
          agent: "claude",
        });
        assert.deepEqual(calls, [{
          project: normalizeProjectPath("proj-b"),
          agent: "claude",
        }]);
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
  });
});

describe("AGE-53 Claude MCP shim startup ensure", () => {
  it("resolveMcpShimProject prefers CLAUDE_PROJECT_DIR then PWD then cwd", () => {
    assert.equal(
      resolveMcpShimProject({
        CLAUDE_PROJECT_DIR: "D:\\from-claude",
        PWD: "D:\\from-pwd",
      }),
      "D:\\from-claude",
    );
    assert.equal(
      resolveMcpShimProject({ PWD: "D:\\from-pwd" }),
      "D:\\from-pwd",
    );
  });

  it("ensureCommsForScopeAtStartup requests ensure_comms_for_scope for resolved project", async () => {
    const requests: Array<{ project: string; agent: string }> = [];
    await ensureCommsForScopeAtStartup({
      agentInUse: () => "claude",
      resolveProject: () => "D:\\proj-from-shim",
      deps: {
        requestEnsure: async (_options, { project, agent }) => {
          requests.push({ project, agent });
        },
      },
    });

    assert.deepEqual(requests, [{ project: "D:\\proj-from-shim", agent: "claude" }]);
  });

  it("swallows startup ensure failures without throwing", async () => {
    await assert.doesNotReject(() =>
      ensureCommsForScopeAtStartup({
        agentInUse: () => "claude",
        resolveProject: () => "proj-x",
        deps: {
          requestEnsure: async () => {
            throw new Error("daemon unavailable");
          },
        },
      }),
    );
  });

  it("returns within the bounded timeout when the startup ensure hangs", async () => {
    const start = Date.now();
    await ensureCommsForScopeAtStartup({
      agentInUse: () => "claude",
      resolveProject: () => "proj-x",
      startupEnsureTimeoutMs: 100,
      deps: {
        requestEnsure: () => new Promise(() => {}),
      },
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 80, `expected at least 80ms elapsed, got ${elapsed}ms`);
    assert.ok(elapsed < 1_000, `expected well under 1s elapsed, got ${elapsed}ms`);
  });

  it("closes the IPC connection when the startup ensure times out", async () => {
    let closed = false;
    const fakeConnection = {
      close: () => {
        closed = true;
      },
    };

    await ensureCommsForScopeAtStartup({
      agentInUse: () => "claude",
      startupEnsureTimeoutMs: 50,
      deps: {
        requestEnsure: async (options) => {
          options.connectionRef.current = fakeConnection;
          await new Promise(() => {});
        },
      },
    });

    assert.equal(closed, true);
  });

  it("closes the IPC connection when a hung daemon request never responds", async () => {
    const server = await startIpcServer({
      onRequest: () => new Promise(() => {}),
    });

    try {
      let socketClosed = false;
      const client = await connectIpc({
        port: server.port,
        clientVersion: "test",
        metadata: { test: "hung-ensure-comms-for-scope" },
      });
      const originalClose = client.close.bind(client);
      client.close = () => {
        socketClosed = true;
        originalClose();
      };

      const connectionRef = { current: client };
      await assert.rejects(
        () =>
          runWithStartupEnsureTimeout(async () => {
            connectionRef.current = client;
            await client.request("ensure_comms_for_scope", {
              project: "proj-hung",
              agent: "claude",
            });
          }, 50),
        /timed out after 50ms/,
      );
      client.close();
      assert.equal(socketClosed, true);
    } finally {
      await server.close();
    }
  });

  it("defaults startup ensure timeout to five seconds", () => {
    assert.equal(DEFAULT_ENSURE_COMMS_SCOPE_TIMEOUT_MS, 5_000);
  });
});

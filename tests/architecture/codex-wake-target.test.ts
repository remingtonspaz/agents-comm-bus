import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import {
  CommLeaseArbiter,
  commLeasePath,
  type AgentLeaseProperties,
  type LeaseRecord,
  type SelfIdentity,
} from "../../core-daemon/runtime/comm-lease.js";
import {
  WebSocketCodexAppServerClient,
  isLiveThreadStatus,
} from "../../core-daemon/bridges/codex/app-server.js";
import { CodexAgentAdapter } from "../../core-daemon/bridges/codex/adapter.js";
import { ensureCommsForSession } from "../../core-daemon/daemon.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
  SessionId,
} from "../../packages/core-contracts/src/types.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";

const PROJECT = normalizeProjectPath("D:\\tmp\\project-a");
const CODEX = "codex" as AgentId;
const TELEGRAM = "telegram" as CommId;
const ENSURE_URL = "ws://127.0.0.1:4700";
const ENSURE_THREAD = "ensure-path-thread";

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "acb-age100-"));
}

function selfIdentity(over: Partial<SelfIdentity> = {}): SelfIdentity {
  return {
    pid: 1000,
    stateRoot: "/state/a",
    checkoutRoot: "/checkout/a",
    daemonBin: null,
    daemonVersion: "0.2.50",
    authorityRank: "main-dev",
    ...over,
  };
}

function codexProperties(
  threadId: string,
  appServerUrl = "ws://127.0.0.1:4500",
): AgentLeaseProperties {
  return { codex: { appServerUrl, threadId } };
}

describe("AGE-100 comm lease agentProperties", () => {
  it("reads legacy lease JSON without agentProperties", async () => {
    const home = await tempHome();
    const leasePath = commLeasePath("telegram", "bot-1", home);
    const legacy: LeaseRecord = {
      comm_id: "telegram",
      resource_id: "bot-1",
      pid: 10,
      stateRoot: "/state/a",
      checkoutRoot: null,
      daemonBin: null,
      daemonVersion: "0.2.49",
      authorityRank: "main-dev",
      acquiredAt: 1,
      renewedAt: 1,
      lastIpcServedAt: 1,
    };
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(leasePath), { recursive: true });
    await writeFile(leasePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 10 }),
      lastIpcServedAt: () => 2,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 2,
    });
    const renewed = await arbiter.renew("telegram", "bot-1");
    assert.equal(renewed.ok, true);
    const onDisk = JSON.parse(await readFile(leasePath, "utf8")) as LeaseRecord;
    assert.equal(onDisk.agentProperties, undefined);
  });

  it("stamps desired Codex properties on acquire and preserves them on same-owner renew", async () => {
    const home = await tempHome();
    const now = { t: 1_000 };
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 20 }),
      lastIpcServedAt: () => now.t,
      homeDir: home,
      isPidAlive: () => true,
      now: () => now.t,
    });
    arbiter.setDesiredAgentProperties("telegram", "bot-1", codexProperties("thread-a"));
    assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
    const leasePath = commLeasePath("telegram", "bot-1", home);
    let onDisk = JSON.parse(await readFile(leasePath, "utf8")) as LeaseRecord;
    assert.deepEqual(onDisk.agentProperties, codexProperties("thread-a"));

    now.t = 2_000;
    arbiter.setDesiredAgentProperties("telegram", "bot-1", codexProperties("thread-b"));
    const renewed = await arbiter.renew("telegram", "bot-1");
    assert.equal(renewed.ok, true);
    onDisk = JSON.parse(await readFile(leasePath, "utf8")) as LeaseRecord;
    assert.deepEqual(onDisk.agentProperties, codexProperties("thread-b"));
    assert.equal(onDisk.acquiredAt, 1_000);
  });

  it("does not inherit a foreign holder's agentProperties on reclaim", async () => {
    const home = await tempHome();
    const now = () => 5_000;
    const foreign = new CommLeaseArbiter({
      self: selfIdentity({ pid: 30, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    foreign.setDesiredAgentProperties("telegram", "bot-1", codexProperties("foreign-thread"));
    assert.equal((await foreign.tryAcquire("telegram", "bot-1")).ok, true);

    const local = new CommLeaseArbiter({
      self: selfIdentity({ pid: 40, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    local.setDesiredAgentProperties("telegram", "bot-1", codexProperties("local-thread"));
    assert.equal((await local.tryAcquire("telegram", "bot-1")).ok, true);

    const onDisk = JSON.parse(
      await readFile(commLeasePath("telegram", "bot-1", home), "utf8"),
    ) as LeaseRecord;
    assert.deepEqual(onDisk.agentProperties, codexProperties("local-thread"));
    assert.notDeepEqual(onDisk.agentProperties, codexProperties("foreign-thread"));
  });

  it("clears foreign agentProperties when reclaiming without locally desired metadata", async () => {
    const home = await tempHome();
    const now = () => 5_000;
    const foreign = new CommLeaseArbiter({
      self: selfIdentity({ pid: 30, authorityRank: "worktree" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    foreign.setDesiredAgentProperties("telegram", "bot-1", codexProperties("foreign-thread"));
    assert.equal((await foreign.tryAcquire("telegram", "bot-1")).ok, true);

    const reclaimer = new CommLeaseArbiter({
      self: selfIdentity({ pid: 40, authorityRank: "main-dev" }),
      lastIpcServedAt: now,
      homeDir: home,
      isPidAlive: () => true,
      now,
    });
    assert.equal((await reclaimer.tryAcquire("telegram", "bot-1")).ok, true);

    const onDisk = JSON.parse(
      await readFile(commLeasePath("telegram", "bot-1", home), "utf8"),
    ) as LeaseRecord;
    assert.equal(onDisk.agentProperties, undefined);
  });

  it("syncAgentProperties updates an already-held lease", async () => {
    const home = await tempHome();
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 50 }),
      lastIpcServedAt: () => 1,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 1,
    });
    arbiter.setDesiredAgentProperties("telegram", "bot-1", codexProperties("thread-initial"));
    assert.equal((await arbiter.tryAcquire("telegram", "bot-1")).ok, true);
    arbiter.setDesiredAgentProperties("telegram", "bot-1", codexProperties("thread-synced"));
    await arbiter.syncAgentProperties("telegram", "bot-1");
    const onDisk = JSON.parse(
      await readFile(commLeasePath("telegram", "bot-1", home), "utf8"),
    ) as LeaseRecord;
    assert.deepEqual(onDisk.agentProperties, codexProperties("thread-synced"));
  });

  it("readHeldCommLease rejects a stale same-pid file not in held inventory", async () => {
    const home = await tempHome();
    const leasePath = commLeasePath("telegram", "bot-1", home);
    const record: LeaseRecord = {
      comm_id: "telegram",
      resource_id: "bot-1",
      pid: 1000,
      stateRoot: "/state/a",
      checkoutRoot: null,
      daemonBin: null,
      daemonVersion: "0.2.50",
      authorityRank: "main-dev",
      acquiredAt: 1,
      renewedAt: 1,
      lastIpcServedAt: 1,
      agentProperties: codexProperties("stale-thread"),
    };
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(leasePath), { recursive: true });
    await writeFile(leasePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 1000 }),
      lastIpcServedAt: () => 1,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 1,
    });
    const lookup = await arbiter.readHeldCommLease("telegram", "bot-1");
    assert.equal(lookup.ok, false);
    if (lookup.ok) return;
    assert.equal(lookup.reason, "not-held-by-self");
  });
});

describe("AGE-100 Codex recorded wake target", () => {
  function makeServer(threads: unknown[]) {
    const seenMethods: string[] = [];
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString());
        if (request.method === "initialize") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
          return;
        }
        seenMethods.push(request.method);
        if (request.method === "thread/list") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { data: threads } }));
          return;
        }
        if (request.method === "thread/turns/list") {
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { data: [{ id: "turn-1", status: "inProgress" }] },
          }));
          return;
        }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
      });
    });
    return { server, seenMethods };
  }

  function liveThread(threadId: string, cwd = PROJECT) {
    return {
      id: threadId,
      cwd,
      status: { type: "active" },
    };
  }

  it("steers and starts only the exact recorded live thread with matching cwd", async () => {
    const { server, seenMethods } = makeServer([
      liveThread("thread-recorded"),
      liveThread("thread-other"),
    ]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected address");
    const client = new WebSocketCodexAppServerClient(`ws://127.0.0.1:${address.port}`);
    const target = { threadId: "thread-recorded", expectedProject: PROJECT };

    const steer = await client.steerRecordedTarget(target, "telegram guidance");
    const wake = await client.wakeRecordedTarget(target, ".");

    assert.deepEqual(steer, { ok: true, threadId: "thread-recorded", method: "turn/steer" });
    assert.deepEqual(wake, { ok: true, threadId: "thread-recorded", method: "turn/start" });
    assert.ok(!seenMethods.includes("thread/loaded/list"));
    assert.deepEqual(
      seenMethods.filter((method) => method === "thread/list").length,
      2,
    );
    server.close();
  });

  it("rejects a foreign live thread when only another id is live on the URL", async () => {
    const { server, seenMethods } = makeServer([liveThread("thread-foreign")]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected address");
    const client = new WebSocketCodexAppServerClient(`ws://127.0.0.1:${address.port}`);
    const result = await client.wakeRecordedTarget({
      threadId: "thread-recorded",
      expectedProject: PROJECT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "recorded-thread-absent");
    assert.ok(!seenMethods.includes("turn/start"));
    assert.ok(!seenMethods.includes("turn/steer"));
    server.close();
  });

  it("rejects a recorded notLoaded thread and never substitutes another live thread", async () => {
    const { server, seenMethods } = makeServer([
      {
        id: "thread-recorded",
        cwd: PROJECT,
        status: { type: "notLoaded" },
      },
      liveThread("thread-live-substitute"),
    ]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected address");
    const client = new WebSocketCodexAppServerClient(`ws://127.0.0.1:${address.port}`);
    const result = await client.steerRecordedTarget({
      threadId: "thread-recorded",
      expectedProject: PROJECT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "recorded-thread-not-live");
    assert.ok(!seenMethods.includes("turn/steer"));
    server.close();
  });

  it("rejects a live recorded thread when cwd does not match the expected project", async () => {
    const { server, seenMethods } = makeServer([
      liveThread("thread-recorded", normalizeProjectPath("D:\\tmp\\other-project")),
    ]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected address");
    const client = new WebSocketCodexAppServerClient(`ws://127.0.0.1:${address.port}`);
    const result = await client.wakeRecordedTarget({
      threadId: "thread-recorded",
      expectedProject: PROJECT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "recorded-thread-wrong-project");
    assert.ok(!seenMethods.includes("turn/start"));
    server.close();
  });

  it("treats only active and idle thread statuses as live", () => {
    assert.equal(isLiveThreadStatus("active"), true);
    assert.equal(isLiveThreadStatus("idle"), true);
    assert.equal(isLiveThreadStatus("notLoaded"), false);
    assert.equal(isLiveThreadStatus("warming"), false);
    assert.equal(isLiveThreadStatus(null), false);
  });
});

describe("AGE-100 CodexAgentAdapter recorded target", () => {
  it("requires an explicit recorded thread id before wake/steer", async () => {
    const fake = new RecordingCodexClient();
    const adapter = new CodexAgentAdapter({ appServerClientFactory: () => fake });
    const session = "session-1" as SessionId;
    await adapter.connect(session, new NoopControlChannel());
    adapter.setWakeTarget(session, { project: PROJECT, appServerUrl: "ws://example", threadId: "thread-1" });

    await adapter.wakeOrSteer(session, { text: "hello" });

    assert.deepEqual(fake.targets, [{ threadId: "thread-1", expectedProject: PROJECT }]);
    assert.equal(fake.steerCalls, 1);
  });
});

class RecordingCodexClient {
  readonly targets: Array<{ threadId: string; expectedProject: string }> = [];
  steerCalls = 0;

  async call(): Promise<unknown> {
    return {};
  }

  async listThreads(): Promise<unknown> {
    return { data: [] };
  }

  async listThreadTurns(): Promise<unknown> {
    return { data: [{ id: "turn-1", status: "inProgress" }] };
  }

  async startTurn(): Promise<unknown> {
    return {};
  }

  async steerTurn(): Promise<unknown> {
    return {};
  }

  async validateRecordedTarget(target: { threadId: string; expectedProject: string }) {
    this.targets.push(target);
    return { ok: true as const, threadId: target.threadId, cwd: target.expectedProject };
  }

  async wakeRecordedTarget(target: { threadId: string; expectedProject: string }) {
    await this.validateRecordedTarget(target);
    return { ok: true as const, threadId: target.threadId, method: "turn/start" as const };
  }

  async steerRecordedTarget(target: { threadId: string; expectedProject: string }) {
    await this.validateRecordedTarget(target);
    this.steerCalls += 1;
    return { ok: true as const, threadId: target.threadId, method: "turn/steer" as const };
  }
}

class NoopControlChannel {
  onClose(): void {}
  async send(): Promise<void> {}
  close(): void {}
}

class LeasedFakeAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly allowedSenderIds: readonly string[] = [];
  startCount = 0;

  constructor(readonly accountId: AccountId) {}

  exclusiveResource() {
    return { resourceId: String(this.accountId) };
  }

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

class LeasedRecordingFactory {
  readonly commId = TELEGRAM;

  async resolveCredentials(): Promise<{ status: "ok"; credentials: Record<string, unknown> }> {
    return { status: "ok", credentials: {} };
  }

  create(_credentials: Record<string, unknown>, accountId: AccountId): CommAdapter {
    return new LeasedFakeAdapter(accountId);
  }
}

describe("AGE-100 ensureCommsForSession lease property ordering", () => {
  it("stamps agentProperties on tryAcquire before post-start sync", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acb-age100-ensure-"));
    const home = join(dir, "lease-home");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const transcripts = new JsonlTranscriptStore(dir);
    const audit = new JsonlAuditStore(dir);
    const blobs = new ContentAddressedBlobStore(dir);
    const bus = new MessageBus({ project: dir, storage, transcripts, audit, blobs, comms: [] });
    const expected = codexProperties(ENSURE_THREAD, ENSURE_URL);
    const arbiter = new CommLeaseArbiter({
      self: selfIdentity({ pid: 60, stateRoot: dir }),
      lastIpcServedAt: () => 1,
      homeDir: home,
      isPidAlive: () => true,
      now: () => 1,
    });
    const baseTryAcquire = arbiter.tryAcquire.bind(arbiter);
    let acquireStamped = false;
    arbiter.tryAcquire = async (commId, resourceId) => {
      const result = await baseTryAcquire(commId, resourceId);
      if (result.ok) {
        const onDisk = JSON.parse(
          await readFile(commLeasePath(commId, resourceId, home), "utf8"),
        ) as LeaseRecord;
        assert.deepEqual(onDisk.agentProperties, expected);
        acquireStamped = true;
      }
      return result;
    };
    const syncCalls: string[] = [];
    const baseSync = arbiter.syncAgentProperties.bind(arbiter);
    arbiter.syncAgentProperties = async (commId, resourceId) => {
      syncCalls.push("sync");
      return baseSync(commId, resourceId);
    };

    try {
      const reg: AccountRegistration = {
        schema_version: SCHEMA_VERSION_ACCOUNT,
        project: PROJECT,
        comm: TELEGRAM,
        agent: CODEX,
        account_label: "main",
        bot_user_id: "bot-ensure",
        registration_id: "reg-bot-ensure",
        credentials_ref: "file:/dev/null",
        created_at: 1,
        updated_at: 1,
      };
      await storage.putAccountRegistration(reg);

      await ensureCommsForSession({
        project: PROJECT,
        agent: CODEX,
        agentLeaseProperties: expected,
        factories: [new LeasedRecordingFactory()],
        bus,
        bridges: [],
        storage,
        env: {},
        blobs,
        stateRoot: dir,
        leaseArbiter: arbiter,
        inFlight: new Set(),
      });

      assert.equal(acquireStamped, true);
      assert.deepEqual(syncCalls, ["sync"]);
      const onDisk = JSON.parse(
        await readFile(commLeasePath(TELEGRAM, "bot-ensure", home), "utf8"),
      ) as LeaseRecord;
      assert.deepEqual(onDisk.agentProperties, expected);
    } finally {
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

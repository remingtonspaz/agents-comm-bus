import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ClaudeBridge } from "../../core-daemon/bridges/claude/bridge.js";
import { ensureDaemon } from "../../core-daemon/bootstrap/ensure-daemon.js";
import {
  addAdapterForRegistration,
  ensureCommsForSession,
  reloadAdapters,
} from "../../core-daemon/daemon.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { resolveDiscoveryPaths, resolveStatePaths } from "../../core-daemon/paths.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
  Conversation,
  ConversationId,
  MessageId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;

registerTempDirCleanup();

async function readAuditKinds(root: string): Promise<string[]> {
  const audit = new JsonlAuditStore(root);
  let text = "";
  try {
    text = await readFile(audit.pathFor(Date.now()), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

function registration(project: string, botId: string, comm: CommId = TELEGRAM): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: normalizeProjectPath(project),
    comm,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: botId,
    registration_id: `reg-${botId}`,
    credentials_ref: "file:/missing/token.json",
    activation: "lazy",
    bot_username: "test_bot",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
  };
}

class NoResolveFactory {
  readonly commId = TELEGRAM;
  async resolveCredentials(): Promise<{ status: "absent" }> {
    return { status: "absent" };
  }
  create(): CommAdapter {
    throw new Error("should not create");
  }
}

test("AGE-57 audits discovery_stale_cleanup when pid file points at a dead process", async () => {
  const stateRoot = await makeTempDir("age57-discovery-");
  const discoveryPaths = resolveDiscoveryPaths({ stateRoot });
  await writeFile(discoveryPaths.pidFile, "424242\n", "utf8");
  await writeFile(discoveryPaths.portFile, "59999\n", "utf8");

  await ensureDaemon({
    stateRoot,
    isPidAlive: () => false,
    probeDaemon: async () => {
      throw new Error("no daemon");
    },
    spawnDaemon: async () => {},
    timeoutMs: 50,
    retryMs: 5,
  }).catch(() => {});

  const kinds = await readAuditKinds(stateRoot);
  assert.ok(kinds.includes("discovery_stale_cleanup"));
});

test("AGE-57 audits wake_delivery_failure on Claude inbound hydration miss", async () => {
  const dir = await makeTempDir("age57-wake-");
  const storage = await openSqliteStorage(pathForDb(dir));
  const audit = new JsonlAuditStore(dir);
  const bus = new MessageBus({
    project: normalizeProjectPath(dir),
    storage,
    transcripts: new JsonlTranscriptStore(dir),
    audit,
  });
  const bridge = new ClaudeBridge({
    storage,
    bus,
    audit,
    pendingInbound: [],
  });

  await bridge.onInboundConversation(conversation({ project: "missing-project" }));
  const kinds = await readAuditKinds(dir);
  assert.ok(kinds.includes("wake_delivery_failure"));
  await storage.close();
});

test("AGE-57 audits comm_adapter_skip when no comm factory is registered", async () => {
  const dir = await makeTempDir("age57-skip-");
  const storage = await openSqliteStorage(pathForDb(dir));
  const audit = new JsonlAuditStore(dir);
  await storage.putAccountRegistration(registration(dir, "bot-a"));
  const bus = new MessageBus({
    project: normalizeProjectPath(dir),
    storage,
    transcripts: new JsonlTranscriptStore(dir),
    audit,
  });
  const blobs = new ContentAddressedBlobStore(dir);
  const leaseArbiter = new CommLeaseArbiter({
    self: {
      pid: process.pid,
      stateRoot: dir,
      checkoutRoot: dir,
      daemonBin: null,
      daemonVersion: "test",
      authorityRank: "worktree",
    },
    homeDir: dir,
  });

  await ensureCommsForSession({
    project: dir,
    agent: CLAUDE,
    factories: [],
    bus,
    bridges: [],
    storage,
    env: {},
    blobs,
    stateRoot: dir,
    leaseArbiter,
    inFlight: new Set(),
    audit,
  });

  const kinds = await readAuditKinds(dir);
  assert.ok(kinds.includes("comm_adapter_skip"));
  await storage.close();
});

test("AGE-57 audits comm_adapter_skip when adapter credentials fail to resolve on reload", async () => {
  const dir = await makeTempDir("age57-reload-skip-");
  const storage = await openSqliteStorage(pathForDb(dir));
  const audit = new JsonlAuditStore(dir);
  const reg = registration(dir, "bot-b");
  await storage.putAccountRegistration(reg);
  const bus = new MessageBus({
    project: normalizeProjectPath(dir),
    storage,
    transcripts: new JsonlTranscriptStore(dir),
    audit,
  });
  const factory = new NoResolveFactory();
  const blobs = new ContentAddressedBlobStore(dir);
  const leaseArbiter = new CommLeaseArbiter({
    self: {
      pid: process.pid,
      stateRoot: dir,
      checkoutRoot: dir,
      daemonBin: null,
      daemonVersion: "test",
      authorityRank: "worktree",
    },
    homeDir: dir,
  });
  const activeScopes = new Set([`${CLAUDE}:${normalizeProjectPath(dir)}`]);

  const summary = await reloadAdapters({
    factories: [factory],
    bridges: [],
    bus,
    storage,
    env: {},
    blobs,
    stateRoot: dir,
    leaseArbiter,
    activeScopes,
    audit,
  });

  assert.equal(summary.skipped.length, 1);
  const kinds = await readAuditKinds(dir);
  assert.ok(kinds.includes("comm_adapter_skip"));
  await storage.close();
});

test("AGE-57 audits comm_adapter_skip when addAdapterForRegistration cannot resolve credentials", async () => {
  const dir = await makeTempDir("age57-add-skip-");
  const storage = await openSqliteStorage(pathForDb(dir));
  const audit = new JsonlAuditStore(dir);
  const bus = new MessageBus({
    project: normalizeProjectPath(dir),
    storage,
    transcripts: new JsonlTranscriptStore(dir),
    audit,
  });
  const factory = new NoResolveFactory();
  const blobs = new ContentAddressedBlobStore(dir);
  const leaseArbiter = new CommLeaseArbiter({
    self: {
      pid: process.pid,
      stateRoot: dir,
      checkoutRoot: dir,
      daemonBin: null,
      daemonVersion: "test",
      authorityRank: "worktree",
    },
    homeDir: dir,
  });
  await storage.putAccountRegistration(registration(dir, "bot-c"));

  const result = await addAdapterForRegistration({
    factory,
    registration: registration(dir, "bot-c"),
    bus,
    bridges: [],
    env: {},
    blobs,
    stateRoot: dir,
    storage,
    leaseArbiter,
  });
  assert.equal(result.ok, false);

  await ensureCommsForSession({
    project: dir,
    agent: CLAUDE,
    factories: [factory],
    bus,
    bridges: [],
    storage,
    env: {},
    blobs,
    stateRoot: dir,
    leaseArbiter,
    inFlight: new Set(),
    audit,
  });

  const kinds = await readAuditKinds(dir);
  assert.ok(kinds.filter((k) => k === "comm_adapter_skip").length >= 1);
  await storage.close();
});

function pathForDb(dir: string): string {
  return resolveStatePaths({ stateRoot: dir }).database;
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    schema_version: 1,
    project: "project-a",
    comm: TELEGRAM,
    account_label: "main",
    bot_user_id: "bot-1",
    chat_native_id: "chat-1",
    thread_native_id: null,
    registration_id: "reg-1",
    conversation_id: "conversation-1" as ConversationId,
    agent: CLAUDE,
    last_inbound_at: 1,
    last_outbound_at: null,
    last_message_id: "telegram:1" as MessageId,
    created_at: 1,
    ...overrides,
  };
}

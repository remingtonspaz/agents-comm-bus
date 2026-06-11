import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  ensureCommsForSession,
} from "../../core-daemon/daemon.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import { createCommFactoryRegistry } from "../../core-daemon/runtime/comm-factory-registry.js";
import { loadCommAdapterFactories } from "../../core-daemon/runtime/comm-adapter-loader.js";
import {
  DuplicateCommIpcMethodError,
  registerCommIpcMethods,
} from "../../core-daemon/runtime/register-comm-ipc-methods.js";
import type { CommAdapterFactory } from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommAdapter,
  CommId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";

const TELEGRAM = "telegram" as CommId;
const DISCORD = "discord" as CommId;
const CLAUDE = "claude" as AgentId;

const createdAdapterDirs: string[] = [];

registerTempDirCleanup();

afterEach(async () => {
  for (const dir of createdAdapterDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempAdaptersDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acb-hot-factory-"));
  createdAdapterDirs.push(dir);
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n', "utf8");
  return dir;
}

function factorySource(commId: string, ipcMethod: string): string {
  return `export function createCommAdapterFactory() {
  return {
    commId: ${JSON.stringify(commId)},
    async resolveCredentials() { return { credentials: {} }; },
    create(_credentials, accountId) {
      return {
        id: ${JSON.stringify(commId)},
        accountId,
        allowedSenderIds: [],
        async start() {},
        async stop() {},
        onInbound() {},
        onConnectionState() {},
        async send() { return { platform_message_id: "x", sent_at: 1 }; },
        reportPressure() { return { backlog: 0, rateLimited: false }; },
        classifyFailure() { return "transient"; },
      };
    },
    ipcMethods() {
      return new Map([[${JSON.stringify(ipcMethod)}, async () => ({ comm: ${JSON.stringify(commId)}, ok: true })]]);
    },
  };
}
`;
}

function registration(project: string, comm: CommId, botId: string): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: normalizeProjectPath(project),
    comm,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: botId,
    registration_id: `reg-${comm}-${botId}`,
    credentials_ref: "file:/missing/token.json",
    bot_username: "test_bot",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
  };
}

function makeArbiter(dir: string): CommLeaseArbiter {
  return new CommLeaseArbiter({
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
}

function stubFactory(commId: CommId, ipcMethod: string): CommAdapterFactory {
  return {
    commId,
    async resolveCredentials() {
      return { credentials: {} };
    },
    create(_credentials, accountId: AccountId): CommAdapter {
      return {
        id: commId,
        accountId,
        allowedSenderIds: [],
        async start() {},
        async stop() {},
        onInbound() {},
        onConnectionState() {},
        async send() {
          return { platform_message_id: "x", sent_at: 1 };
        },
        reportPressure() {
          return { backlog: 0, rateLimited: false };
        },
        classifyFailure() {
          return "transient";
        },
      };
    },
    ipcMethods() {
      return new Map([[ipcMethod, async () => ({ comm: commId, ok: true })]]);
    },
  };
}

async function readAuditLines(root: string): Promise<Array<Record<string, unknown>>> {
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
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("AGE-49 hot comm factory reload", () => {
  it("discovers a new comm factory on-demand and registers its IPC methods", async () => {
    const adaptersDir = await tempAdaptersDir();
    await writeFile(path.join(adaptersDir, "telegram.js"), factorySource("telegram", "telegram_ping"), "utf8");

    const startupFactories = await loadCommAdapterFactories({ adaptersDir });
    assert.deepEqual(startupFactories.map((f) => f.commId), ["telegram"]);

    await writeFile(path.join(adaptersDir, "discord.js"), factorySource("discord", "discord_ping"), "utf8");

    const ipcMethods = new Map<string, IpcMethodHandler>();
    const registry = createCommFactoryRegistry({
      initial: startupFactories,
      loadFactories: () => loadCommAdapterFactories({ adaptersDir }),
      ipcMethods,
      ipcDeps: { bus: null as never, storage: null as never, pendingInbound: [] },
    });

    assert.equal(ipcMethods.has("discord_ping"), false, "discord IPC not registered at startup");
    const factory = await registry.rescanFactoriesForComm("discord");
    assert.ok(factory, "discord factory discovered on-demand");
    assert.equal(factory.commId, "discord");
    assert.equal(ipcMethods.has("discord_ping"), true, "discord IPC method is dispatchable after re-scan");

    const handler = ipcMethods.get("discord_ping");
    assert.deepEqual(await handler?.({}, {}), { comm: "discord", ok: true });
  });

  it("does not re-scan when the comm factory is already loaded", async () => {
    const adaptersDir = await tempAdaptersDir();
    await writeFile(path.join(adaptersDir, "telegram.js"), factorySource("telegram", "telegram_ping"), "utf8");

    let loadCalls = 0;
    const ipcMethods = new Map<string, IpcMethodHandler>();
    const registry = createCommFactoryRegistry({
      initial: [stubFactory(TELEGRAM, "telegram_ping")],
      loadFactories: async () => {
        loadCalls += 1;
        return loadCommAdapterFactories({ adaptersDir });
      },
      ipcMethods,
      ipcDeps: { bus: null as never, storage: null as never, pendingInbound: [] },
    });

    const factory = await registry.rescanFactoriesForComm("telegram");
    assert.equal(factory?.commId, "telegram");
    assert.equal(loadCalls, 0, "already-loaded comm must not trigger a re-scan");
  });

  it("re-scanning twice is idempotent and does not double-register IPC methods", async () => {
    const adaptersDir = await tempAdaptersDir();
    await writeFile(path.join(adaptersDir, "discord.js"), factorySource("discord", "discord_ping"), "utf8");

    const ipcMethods = new Map<string, IpcMethodHandler>();
    const registry = createCommFactoryRegistry({
      initial: [],
      loadFactories: () => loadCommAdapterFactories({ adaptersDir }),
      ipcMethods,
      ipcDeps: { bus: null as never, storage: null as never, pendingInbound: [] },
    });

    await registry.rescanFactoriesForComm("discord");
    await registry.rescanFactoriesForComm("discord");

    assert.equal(registry.factories.length, 1);
    assert.equal(ipcMethods.size, 1);
    assert.equal(ipcMethods.has("discord_ping"), true);
  });

  it("fails loud when a different factory registers a duplicate IPC method", () => {
    const ipcMethods = new Map<string, IpcMethodHandler>();
    const deps = { bus: null as never, storage: null as never, pendingInbound: [] };
    registerCommIpcMethods(ipcMethods, stubFactory(TELEGRAM, "shared_send"), deps);

    assert.throws(
      () => registerCommIpcMethods(ipcMethods, stubFactory(DISCORD, "shared_send"), deps),
      (error: unknown) => error instanceof DuplicateCommIpcMethodError,
      "duplicate IPC method names must throw, not shadow",
    );
  });

  it("audits and logs loudly when re-scan still finds no factory", async () => {
    const dir = await makeTempDir("acb-hot-missing-");
    const storage = await openSqliteStorage(path.join(dir, "storage.db"));
    const audit = new JsonlAuditStore(dir);
    await storage.putAccountRegistration(registration(dir, "matrix" as CommId, "bot-missing"));

    const ipcMethods = new Map<string, IpcMethodHandler>();
    const registry = createCommFactoryRegistry({
      initial: [],
      loadFactories: async () => [],
      ipcMethods,
      ipcDeps: {
        bus: new MessageBus({
          project: dir,
          storage,
          transcripts: new JsonlTranscriptStore(dir),
          audit,
        }),
        storage,
        pendingInbound: [],
      },
    });

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await ensureCommsForSession({
        project: dir,
        agent: CLAUDE,
        factories: registry.factories,
        rescanFactories: (comm) => registry.rescanFactoriesForComm(comm),
        bus: new MessageBus({
          project: dir,
          storage,
          transcripts: new JsonlTranscriptStore(dir),
          audit,
        }),
        bridges: [],
        storage,
        env: {},
        blobs: new ContentAddressedBlobStore(dir),
        stateRoot: dir,
        leaseArbiter: makeArbiter(dir),
        inFlight: new Set(),
        audit,
      });
    } finally {
      console.error = originalError;
      await storage.close();
    }

    const lines = await readAuditLines(dir);
    const skip = lines.find((line) => line.kind === "comm_adapter_skip");
    assert.ok(skip, "comm_adapter_skip audit emitted");
    assert.equal((skip.detail as { reason?: string }).reason, "no_comm_factory");
    assert.equal((skip.detail as { rescanned?: boolean }).rescanned, true);
    assert.ok(
      errors.some((line) => /matrix/.test(line) && /re-scan/.test(line)),
      "operator-visible console.error after failed re-scan",
    );
  });

  it("brings up an adapter after on-demand factory discovery via ensureCommsForSession", async () => {
    const dir = await makeTempDir("acb-hot-ensure-");
    const adaptersDir = await tempAdaptersDir();
    await writeFile(path.join(adaptersDir, "discord.js"), factorySource("discord", "discord_ping"), "utf8");

    const storage = await openSqliteStorage(path.join(dir, "storage.db"));
    const audit = new JsonlAuditStore(dir);
    const transcripts = new JsonlTranscriptStore(dir);
    const bus = new MessageBus({ project: dir, storage, transcripts, audit, comms: [] });
    await storage.putAccountRegistration(registration(dir, DISCORD, "bot-discord"));

    const ipcMethods = new Map<string, IpcMethodHandler>();
    const registry = createCommFactoryRegistry({
      initial: [],
      loadFactories: () => loadCommAdapterFactories({ adaptersDir }),
      ipcMethods,
      ipcDeps: { bus, storage, pendingInbound: [] },
    });

    await ensureCommsForSession({
      project: dir,
      agent: CLAUDE,
      factories: registry.factories,
      rescanFactories: (comm) => registry.rescanFactoriesForComm(comm),
      bus,
      bridges: [],
      storage,
      env: {},
      blobs: new ContentAddressedBlobStore(dir),
      stateRoot: dir,
      leaseArbiter: makeArbiter(dir),
      inFlight: new Set(),
      audit,
    });

    assert.ok(bus.getComm(DISCORD, "bot-discord" as AccountId), "adapter started after on-demand factory load");
    assert.equal(ipcMethods.has("discord_ping"), true, "IPC surface registered for the new comm");
    await storage.close();
  });
});

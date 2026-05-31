import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  AccountId,
  AccountRegistration,
  AgentId,
  ChatRef,
  CommAdapter,
  CommConnectionState,
  CommId,
  FailureClassification,
  Message,
  OutboundPayload,
  SendResult,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { TelegramCommAdapterFactory } from "../../adapters/telegram/factory.js";
import { reloadAdapters } from "../../core-daemon/daemon.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const BOT_ID = "111111";

function registration(project: string): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project,
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: BOT_ID,
    credentials_ref: "env:TEST_TOKEN",
    bot_username: "test_bot",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
  };
}

describe("reload-path allowlist refresh", () => {
  it("updates an attached adapter's allowedSenderIds in place when DB rows change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-reload-allowlist-"));
    try {
      const storage = await openSqliteStorage(join(dir, "storage.db"));
      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });

      // Seed: one account registration + one global allowlist entry.
      await storage.putAccountRegistration(registration(dir));
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "A",
        added_at: 1,
      });

      // Build the adapter via the real factory (no `start()` — we don't
      // need a live Telegram connection for this test).
      const factory = new TelegramCommAdapterFactory();
      const env = { TEST_TOKEN: "fake-token" };
      const resolved = await factory.resolveCredentials(
        registration(dir),
        env,
        { storage },
      );
      assert.ok(resolved, "initial resolveCredentials should succeed");
      const adapter = factory.create(resolved.credentials, BOT_ID as AccountId, {
        blobs,
        stateRoot: dir,
      });
      bus.registerComm(adapter);

      assert.deepEqual(
        [...(adapter.allowedSenderIds ?? [])].sort(),
        ["A"],
        "adapter should start with the single seeded allowlist id",
      );

      // Mutation: insert a second allowlist row directly into storage.
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "B",
        added_at: 2,
      });

      // Trigger reload — should detect the unchanged (commId, accountId) but
      // refreshed allowlist source, and update the adapter in place.
      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: env as unknown as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
      });

      const live = bus.getComm(TELEGRAM, BOT_ID as AccountId);
      assert.equal(live, adapter, "should be the same adapter instance");
      assert.deepEqual(
        [...(live!.allowedSenderIds ?? [])].sort(),
        ["A", "B"],
        "adapter should expose the unioned allowlist after reload",
      );
      assert.equal(summary.added.length, 0, "no new attaches expected");
      assert.equal(summary.removed.length, 0, "no detaches expected");
      assert.equal(summary.updated.length, 1, "expected one updated entry");
      assert.deepEqual(summary.updated[0], {
        comm: TELEGRAM,
        account_id: BOT_ID,
        what: "allowlist",
      });

      await storage.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not record an update when the allowlist set is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-reload-noop-"));
    try {
      const storage = await openSqliteStorage(join(dir, "storage.db"));
      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });

      await storage.putAccountRegistration(registration(dir));
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "A",
        added_at: 1,
      });

      const factory = new TelegramCommAdapterFactory();
      const env = { TEST_TOKEN: "fake-token" };
      const resolved = await factory.resolveCredentials(
        registration(dir),
        env,
        { storage },
      );
      const adapter = factory.create(resolved!.credentials, BOT_ID as AccountId, {
        blobs,
        stateRoot: dir,
      });
      bus.registerComm(adapter);

      // No storage mutation between attach and reload.
      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: env as unknown as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
      });

      assert.equal(summary.updated.length, 0, "no allowlist change → no update event");
      assert.equal(summary.added.length, 0);
      assert.equal(summary.removed.length, 0);

      await storage.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats allowlist sets as unordered (no phantom update on reorder)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-reload-order-"));
    try {
      const storage = await openSqliteStorage(join(dir, "storage.db"));
      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });

      await storage.putAccountRegistration(registration(dir));

      const factory = new TelegramCommAdapterFactory();
      const envInitial = { TEST_TOKEN: "fake-token", TELEGRAM_USER_ID: "A,B" };
      const resolved = await factory.resolveCredentials(
        registration(dir),
        envInitial,
        { storage },
      );
      const adapter = factory.create(resolved!.credentials, BOT_ID as AccountId, {
        blobs,
        stateRoot: dir,
      });
      bus.registerComm(adapter);
      assert.deepEqual([...(adapter.allowedSenderIds ?? [])].sort(), ["A", "B"]);

      // Same set, different CSV order — the reload-path diff must be
      // order-independent so this does NOT trigger a phantom update.
      const envReordered = { TEST_TOKEN: "fake-token", TELEGRAM_USER_ID: "B,A" };
      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: envReordered as unknown as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
      });

      assert.equal(summary.updated.length, 0, "reorder must not count as a change");
      assert.equal(summary.added.length, 0);
      assert.equal(summary.removed.length, 0);

      await storage.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces resolveCredentials failure on reload as a skipped entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-reload-failresolve-"));
    try {
      const storage = await openSqliteStorage(join(dir, "storage.db"));
      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });

      await storage.putAccountRegistration(registration(dir));

      const factory = new TelegramCommAdapterFactory();
      const envInitial = { TEST_TOKEN: "fake-token" };
      const resolved = await factory.resolveCredentials(
        registration(dir),
        envInitial,
        { storage },
      );
      const adapter = factory.create(resolved!.credentials, BOT_ID as AccountId, {
        blobs,
        stateRoot: dir,
      });
      bus.registerComm(adapter);

      // Reload with env missing the token — resolveCredentials returns
      // undefined (env path can't find the token, no file fallback exists
      // at the test's temp project path). The unchanged branch must
      // surface this as a skipped entry, not silently continue.
      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: {} as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
      });

      assert.equal(summary.skipped.length, 1, "credential failure must be surfaced");
      assert.match(
        summary.skipped[0].reason,
        /could not re-resolve credentials_ref/,
      );
      assert.equal(summary.skipped[0].account_id, BOT_ID);
      // Live adapter should be untouched; the reload doesn't destroy state
      // when re-resolution fails.
      const live = bus.getComm(TELEGRAM, BOT_ID as AccountId);
      assert.equal(live, adapter);

      await storage.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates allowedSenderIds when per-bot rows are added", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-reload-perbot-"));
    try {
      const storage = await openSqliteStorage(join(dir, "storage.db"));
      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });

      await storage.putAccountRegistration(registration(dir));

      const factory = new TelegramCommAdapterFactory();
      const env = { TEST_TOKEN: "fake-token" };
      const resolved = await factory.resolveCredentials(
        registration(dir),
        env,
        { storage },
      );
      const adapter = factory.create(resolved!.credentials, BOT_ID as AccountId, {
        blobs,
        stateRoot: dir,
      });
      bus.registerComm(adapter);
      assert.deepEqual([...(adapter.allowedSenderIds ?? [])], []);

      // Per-bot row should be picked up too (the factory's union covers both
      // allowlist_global and allowlist_per_bot for this bot).
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: BOT_ID,
        sender_id: "perbot-x",
        added_at: 1,
      });

      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: env as unknown as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
      });

      const live = bus.getComm(TELEGRAM, BOT_ID as AccountId);
      assert.deepEqual([...(live!.allowedSenderIds ?? [])], ["perbot-x"]);
      assert.equal(summary.updated.length, 1);

      await storage.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restarts an unchanged adapter when credential refresh is forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-reload-credentials-"));
    try {
      const storage = await openSqliteStorage(join(dir, "storage.db"));
      const transcripts = new JsonlTranscriptStore(dir);
      const audit = new JsonlAuditStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });

      await storage.putAccountRegistration(registration(dir));
      const factory = new FakeCredentialFactory();
      const oldAdapter = factory.create({ botToken: "old-token" }, BOT_ID as AccountId, {
        blobs,
        stateRoot: dir,
      }) as FakeCredentialAdapter;
      bus.registerComm(oldAdapter);

      const summary = await reloadAdapters({
        factories: [factory],
        bridges: [],
        bus,
        storage,
        env: { TEST_TOKEN: "new-token" } as unknown as NodeJS.ProcessEnv,
        blobs,
        stateRoot: dir,
        options: {
          forceCredentialRefresh: [{ comm: TELEGRAM, accountId: BOT_ID }],
        },
      });

      const live = bus.getComm(TELEGRAM, BOT_ID as AccountId);
      assert.notEqual(live, oldAdapter, "credential refresh should replace the adapter instance");
      assert.equal(oldAdapter.stopCount, 1);
      assert.equal((live as FakeCredentialAdapter).token, "new-token");
      assert.equal((live as FakeCredentialAdapter).startCount, 1);
      assert.deepEqual(summary.updated, [{
        comm: TELEGRAM,
        account_id: BOT_ID,
        what: "credentials",
      }]);

      await storage.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

class FakeCredentialFactory {
  readonly commId = TELEGRAM;

  async resolveCredentials(
    rec: AccountRegistration,
    env: NodeJS.ProcessEnv,
  ): Promise<{ credentials: Record<string, unknown> } | undefined> {
    const name = rec.credentials_ref.replace(/^env:/, "");
    const token = env[name];
    return token ? { credentials: { botToken: token } } : undefined;
  }

  create(
    credentials: Record<string, unknown>,
    accountId: AccountId,
  ): CommAdapter {
    return new FakeCredentialAdapter(accountId, String(credentials.botToken ?? ""));
  }
}

class FakeCredentialAdapter implements CommAdapter {
  readonly id = TELEGRAM;
  readonly allowedSenderIds: readonly string[] = [];
  startCount = 0;
  stopCount = 0;

  constructor(readonly accountId: AccountId, readonly token: string) {}

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  onInbound(_handler: (msg: Message) => Promise<void>): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}

  async send(
    _target: ChatRef,
    _payload: OutboundPayload,
    _idempotencyKey: string,
  ): Promise<SendResult> {
    return { platform_message_id: "fake", sent_at: 1 };
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }

  classifyFailure(_error: unknown): FailureClassification {
    return "transient";
  }
}

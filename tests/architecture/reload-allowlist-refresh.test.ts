import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommId,
} from "../../agents-comm-bus-core/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../agents-comm-bus-core/src/types.js";
import { MessageBus } from "../../agents-comm-bus/src/bus.js";
import { ContentAddressedBlobStore } from "../../agents-comm-bus/src/storage/blobs.js";
import { JsonlAuditStore } from "../../agents-comm-bus/src/storage/audit.js";
import { JsonlTranscriptStore } from "../../agents-comm-bus/src/storage/transcripts.js";
import { openSqliteStorage } from "../../agents-comm-bus/src/storage/sqlite.js";
import { TelegramCommAdapterFactory } from "../../agents-comm-bus/src/adapters/comm/telegram/factory.js";
import { reloadAdapters } from "../../agents-comm-bus/src/daemon.js";

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
});

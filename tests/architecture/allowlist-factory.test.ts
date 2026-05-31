import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { TelegramCommAdapterFactory } from "../../adapters/telegram/factory.js";
import type {
  AccountRegistration,
  AgentId,
  CommId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/index.js";

const TELEGRAM = "telegram" as CommId;
const CLAUDE = "claude" as AgentId;
const CODEX = "codex" as AgentId;

function makeRegistration(overrides: Partial<AccountRegistration> = {}): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: "/tmp/project-allowlist-test",
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: "8950482517",
    credentials_ref: "file:/missing/telegram.json",
    bot_username: "Refactor_Claude_Test",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
    ...overrides,
  };
}

async function withStorage<T>(test: (dir: string, dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-allowlist-factory-"));
  try {
    return await test(dir, join(dir, "storage.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeCredentialFile(
  dir: string,
  body: { botToken: string; userId?: string[] },
): Promise<string> {
  const path = join(dir, "telegram.json");
  await writeFile(path, JSON.stringify(body));
  return `file:${path}`;
}

describe("Telegram factory allowlist union", () => {
  it("unions env CSV with allowlist_global and allowlist_per_bot rows", async () => {
    await withStorage(async (dir, dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "global-sender",
        added_at: 1,
      });
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
        sender_id: "perbot-sender",
        added_at: 2,
      });
      // Another bot's per-bot row should NOT appear in this adapter's union.
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8988792099",
        sender_id: "other-bot-sender",
        added_at: 3,
      });

      const factory = new TelegramCommAdapterFactory();
      const resolved = await factory.resolveCredentials(
        makeRegistration({
          credentials_ref: await writeCredentialFile(dir, { botToken: "test-token" }),
        }),
        {
          TELEGRAM_USER_ID: "env-sender-1,env-sender-2",
        },
        { storage },
      );
      assert.ok(resolved, "resolveCredentials returned undefined");
      const allowed = resolved.credentials.allowedUserIds as string[];
      assert.deepEqual(
        [...allowed].sort(),
        [
          "env-sender-1",
          "env-sender-2",
          "global-sender",
          "perbot-sender",
        ].sort(),
        "expected env + global + per-bot union, scoped to this bot",
      );
      // The other-bot sender should NOT appear.
      assert.equal(
        allowed.includes("other-bot-sender"),
        false,
        "another bot's per-bot row leaked into this bot's allowlist",
      );

      await storage.close();
    });
  });

  it("deduplicates ids that appear in multiple sources", async () => {
    await withStorage(async (dir, dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistGlobal({
        comm: TELEGRAM,
        sender_id: "8296218244", // also in env
        added_at: 1,
      });
      await storage.addAllowlistPerBot({
        comm: TELEGRAM,
        bot_user_id: "8950482517",
        sender_id: "8296218244", // also in env and global
        added_at: 2,
      });

      const factory = new TelegramCommAdapterFactory();
      const resolved = await factory.resolveCredentials(
        makeRegistration({
          credentials_ref: await writeCredentialFile(dir, { botToken: "test-token" }),
        }),
        {
          TELEGRAM_USER_ID: "8296218244",
        },
        { storage },
      );
      const allowed = (resolved!.credentials.allowedUserIds as string[]).slice();
      assert.deepEqual(allowed, ["8296218244"], "expected single entry after dedup");
      await storage.close();
    });
  });

  it("works when no storage context is provided (file ref + env allowlist path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-allowlist-no-storage-"));
    try {
      const factory = new TelegramCommAdapterFactory();
      const resolved = await factory.resolveCredentials(
        makeRegistration({
          credentials_ref: await writeCredentialFile(dir, { botToken: "test-token" }),
        }),
        {
          TELEGRAM_USER_ID: "env-only-sender",
        },
        // No `context` argument
      );
      assert.ok(resolved);
      assert.deepEqual(resolved.credentials.allowedUserIds, ["env-only-sender"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not resolve env refs or project-local telegram.json fallbacks", async () => {
    const project = await mkdtemp(join(tmpdir(), "acb-codex-telegram-config-"));
    try {
      await mkdir(join(project, ".claude"));
      await mkdir(join(project, ".codex"));
      await writeFile(
        join(project, ".claude", "telegram.json"),
        JSON.stringify({ botToken: "claude-token", userId: ["claude-user"] }),
      );
      await writeFile(
        join(project, ".codex", "telegram.json"),
        JSON.stringify({ botToken: "codex-token", userId: ["codex-user"] }),
      );

      const factory = new TelegramCommAdapterFactory();
      const resolved = await factory.resolveCredentials(
        makeRegistration({
          project,
          agent: CODEX,
          credentials_ref: "env:TELEGRAM_BOT_TOKEN",
        }),
        { TELEGRAM_BOT_TOKEN: "env-token" },
      );

      assert.equal(resolved, undefined);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

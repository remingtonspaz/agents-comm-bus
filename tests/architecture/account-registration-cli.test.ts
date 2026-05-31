import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { accountAdd } from "../../core-daemon/cli/account-add.js";
import { accountRelabel } from "../../core-daemon/cli/account-relabel.js";
import { accountRemove } from "../../core-daemon/cli/account-remove.js";
import { accountUpdateToken } from "../../core-daemon/cli/account-update-token.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { resolveStatePaths } from "../../core-daemon/paths.js";
import type { ConversationId } from "../../packages/core-contracts/src/types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("account registration CLI contract", () => {
  it("exposes explicit account subcommands without implicit registration wording", () => {
    const source = readFileSync(resolve(repoRoot, "core-daemon/cli/index.ts"), "utf8");
    const accountAddSource = readFileSync(resolve(repoRoot, "core-daemon/cli/account-add.ts"), "utf8");

    assert.match(source, /account-add/);
    assert.match(source, /account-list/);
    assert.match(source, /account-remove/);
    assert.match(source, /account-relabel/);
    assert.match(source, /account-update-token/);
    assert.doesNotMatch(source, /implicit/i);
    assert.doesNotMatch(source, /credentials-ref/);
    assert.doesNotMatch(source, /credentialsRef/);
    assert.doesNotMatch(accountAddSource, /TELEGRAM_BOT_TOKEN/);
  });

  it("persists bot-token registrations as daemon-owned file credentials by default", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-add-"));

    const rec = await accountAdd({
      project: "D:\\Projects\\stonks",
      agent: "codex",
      accountLabel: "stonks codex dev",
      botToken: "secret-token",
      stateRoot,
      probeIdentity: async () => ({
        bot_user_id: "8743694023",
        bot_username: "sd_stonks_codex_dev_bot",
      }),
    });

    assert.equal(rec.credentials_ref.startsWith("file:"), true);
    assert.match(rec.credentials_ref, /tokens[\\/]+telegram[\\/]+stonks-[a-f0-9]{12}[\\/]+codex[\\/]+8743694023\.json$/);
    const tokenFile = rec.credentials_ref.slice("file:".length);
    assert.equal(existsSync(tokenFile), true);
    assert.deepEqual(JSON.parse(await readFile(tokenFile, "utf8")), {
      botToken: "secret-token",
    });
  });

  it("rejects account-add when the bot id is already registered", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-add-"));

    await accountAdd({
      project: "D:\\Projects\\stonks",
      agent: "codex",
      accountLabel: "main",
      botToken: "secret-token",
      stateRoot,
      probeIdentity: identity("8743694023", "sd_stonks_codex_dev_bot"),
    });

    await assert.rejects(
      () => accountAdd({
        project: "D:\\Projects\\other",
        agent: "claude",
        accountLabel: "main",
        botToken: "same-bot-token",
        stateRoot,
        probeIdentity: identity("8743694023", "sd_stonks_codex_dev_bot"),
      }),
      (error: Error) => {
        assert.match(error.message, /already registered/);
        assert.match(error.message, /8743694023/);
        assert.match(error.message, /account-remove --comm telegram --bot-id 8743694023/);
        return true;
      },
    );
  });

  it("rejects account-add when the account label already exists", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-add-"));

    await accountAdd({
      project: "D:\\Projects\\stonks",
      agent: "codex",
      accountLabel: "main",
      botToken: "secret-token",
      stateRoot,
      probeIdentity: identity("8743694023", "sd_stonks_codex_dev_bot"),
    });

    await assert.rejects(
      () => accountAdd({
        project: "D:\\Projects\\stonks",
        agent: "codex",
        accountLabel: "main",
        botToken: "replacement-token",
        stateRoot,
        probeIdentity: identity("8988792099", "sd_stonks_replacement_bot"),
      }),
      (error: Error) => {
        assert.match(error.message, /account label main is already registered/);
        assert.match(error.message, /8743694023/);
        assert.match(error.message, /account-update command when available/);
        return true;
      },
    );
  });

  it("removes account registrations by bot id", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-remove-"));

    await accountAdd({
      project: "D:\\Projects\\stonks",
      agent: "codex",
      accountLabel: "main",
      botToken: "secret-token",
      stateRoot,
      probeIdentity: identity("8743694023", "sd_stonks_codex_dev_bot"),
    });

    await accountRemove({ comm: "telegram", botId: "8743694023", stateRoot });

    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot }).database);
    try {
      assert.equal(await storage.getAccountByBot("telegram", "8743694023"), null);
    } finally {
      await storage.close();
    }
  });

  it("rejects ambiguous label-based account removal", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-remove-"));

    await accountAdd({
      project: "D:\\Projects\\claude",
      agent: "claude",
      accountLabel: "main",
      botToken: "claude-token",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });
    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    await assert.rejects(
      () => accountRemove({ comm: "telegram", accountLabel: "main", stateRoot }),
      (error: Error) => {
        assert.match(error.message, /ambiguous/);
        assert.match(error.message, /8950482517/);
        assert.match(error.message, /8988792099/);
        assert.match(error.message, /--bot-id/);
        return true;
      },
    );
  });

  it("removes account registrations by an unambiguous label selector", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-remove-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    await accountRemove({
      comm: "telegram",
      agent: "codex",
      accountLabel: "main",
      stateRoot,
    });

    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot }).database);
    try {
      assert.equal(await storage.getAccountByBot("telegram", "8988792099"), null);
    } finally {
      await storage.close();
    }
  });

  it("relabels an account by bot id and conversation reads resolve the new label", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-relabel-"));

    const registration = await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    const conversationId = "conv-codex-relabel" as ConversationId;
    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot }).database);
    try {
      await storage.upsertConversation({
        schema_version: 1,
        project: "D:\\Projects\\codex",
        comm: "telegram",
        account_label: "main",
        bot_user_id: "8988792099",
        registration_id: registration.registration_id,
        chat_native_id: "-100",
        thread_native_id: null,
        conversation_id: conversationId,
        agent: "codex",
        last_inbound_at: null,
        last_outbound_at: null,
        last_message_id: null,
        created_at: 1,
      });
    } finally {
      await storage.close();
    }

    const result = await accountRelabel({
      comm: "telegram",
      botId: "8988792099",
      newAccountLabel: "codex-main",
      stateRoot,
    });

    assert.equal(result.previous.account_label, "main");
    assert.equal(result.next.account_label, "codex-main");
    assert.equal(result.next.registration_id, registration.registration_id);

    const verify = await openSqliteStorage(resolveStatePaths({ stateRoot }).database);
    try {
      const account = await verify.getAccountByBot("telegram", "8988792099");
      assert.equal(account?.account_label, "codex-main");
      const conversation = await verify.getConversation(conversationId);
      assert.equal(conversation?.conversation_id, conversationId);
      assert.equal(conversation?.account_label, "codex-main");
    } finally {
      await verify.close();
    }
  });

  it("relabels an account by an unambiguous label selector", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-relabel-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    const result = await accountRelabel({
      comm: "telegram",
      accountLabel: "main",
      agent: "codex",
      newAccountLabel: "codex-main",
      stateRoot,
    });

    assert.equal(result.next.account_label, "codex-main");
    assert.equal(result.next.bot_user_id, "8988792099");
  });

  it("rejects ambiguous label-based relabel targets", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-relabel-"));

    await accountAdd({
      project: "D:\\Projects\\claude",
      agent: "claude",
      accountLabel: "main",
      botToken: "claude-token",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });
    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    await assert.rejects(
      () => accountRelabel({
        comm: "telegram",
        accountLabel: "main",
        newAccountLabel: "shared-main",
        stateRoot,
      }),
      (error: Error) => {
        assert.match(error.message, /ambiguous/);
        assert.match(error.message, /8950482517/);
        assert.match(error.message, /8988792099/);
        return true;
      },
    );
  });

  it("rejects relabeling to an existing label in the same project and agent", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-relabel-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });
    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "backup",
      botToken: "backup-token",
      stateRoot,
      probeIdentity: identity("7777777777", "sd_backup_bot"),
    });

    await assert.rejects(
      () => accountRelabel({
        comm: "telegram",
        botId: "8988792099",
        newAccountLabel: "backup",
        stateRoot,
      }),
      (error: Error) => {
        assert.match(error.message, /account label backup is already registered/);
        assert.match(error.message, /7777777777/);
        return true;
      },
    );
  });

  it("rotates a same-bot token without changing the bot id", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-update-token-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "old-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    const result = await accountUpdateToken({
      comm: "telegram",
      botId: "8988792099",
      botToken: "new-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot_renamed"),
    });

    assert.equal(result.bot_changed, false);
    assert.equal(result.previous.bot_user_id, "8988792099");
    assert.equal(result.next.bot_user_id, "8988792099");
    assert.equal(result.next.bot_username, "sd_codex_bot_renamed");
    const tokenFile = result.next.credentials_ref.slice("file:".length);
    assert.deepEqual(JSON.parse(await readFile(tokenFile, "utf8")), {
      botToken: "new-token",
    });
  });

  it("rejects a different-bot token unless --allow-bot-change is set", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-update-token-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "old-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    await assert.rejects(
      () => accountUpdateToken({
        comm: "telegram",
        botId: "8988792099",
        botToken: "other-bot-token",
        stateRoot,
        probeIdentity: identity("8950482517", "sd_claude_bot"),
      }),
      (error: Error) => {
        assert.match(error.message, /Token belongs to a different bot/);
        assert.match(error.message, /8988792099 -> 8950482517/);
        assert.match(error.message, /--allow-bot-change/);
        return true;
      },
    );
  });

  it("rejects bot replacement when the new bot id is already registered", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-update-token-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });
    await accountAdd({
      project: "D:\\Projects\\claude",
      agent: "claude",
      accountLabel: "main",
      botToken: "claude-token",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });

    await assert.rejects(
      () => accountUpdateToken({
        comm: "telegram",
        botId: "8988792099",
        botToken: "claude-token",
        allowBotChange: true,
        stateRoot,
        probeIdentity: identity("8950482517", "sd_claude_bot"),
      }),
      (error: Error) => {
        assert.match(error.message, /already registered/);
        assert.match(error.message, /8950482517/);
        assert.match(error.message, /cannot replace 8988792099/);
        return true;
      },
    );
  });

  it("replaces bot identity with explicit confirmation and migrates bot-id references", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-update-token-"));

    const initial = await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "old-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });
    const oldTokenFile = initial.credentials_ref.slice("file:".length);

    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot }).database);
    const conversationId = "conv-codex-bot-replace" as ConversationId;
    try {
      await storage.addAllowlistPerBot({
        comm: "telegram",
        bot_user_id: "8988792099",
        sender_id: "1234",
        added_at: 1,
      });
      await storage.upsertConversation({
        schema_version: 1,
        project: "D:\\Projects\\codex",
        comm: "telegram",
        account_label: "main",
        bot_user_id: "8988792099",
        registration_id: initial.registration_id,
        chat_native_id: "-100",
        thread_native_id: null,
        conversation_id: conversationId,
        agent: "codex",
        last_inbound_at: null,
        last_outbound_at: null,
        last_message_id: null,
        created_at: 1,
      });
    } finally {
      await storage.close();
    }

    const result = await accountUpdateToken({
      comm: "telegram",
      accountLabel: "main",
      agent: "codex",
      botToken: "replacement-token",
      allowBotChange: true,
      stateRoot,
      probeIdentity: identity("7777777777", "sd_replacement_bot"),
    });

    assert.equal(result.bot_changed, true);
    assert.equal(result.migrated_allowlist_rows, 1);
    assert.equal(result.migrated_conversation_rows, 1);
    assert.equal(result.next.bot_user_id, "7777777777");
    assert.equal(existsSync(oldTokenFile), false);
    assert.deepEqual(
      JSON.parse(await readFile(result.next.credentials_ref.slice("file:".length), "utf8")),
      { botToken: "replacement-token" },
    );

    const verify = await openSqliteStorage(resolveStatePaths({ stateRoot }).database);
    try {
      assert.equal(await verify.getAccountByBot("telegram", "8988792099"), null);
      assert.ok(await verify.getAccountByBot("telegram", "7777777777"));
      assert.deepEqual(await verify.listAllowlistPerBot({
        comm: "telegram",
        bot_user_id: "7777777777",
      }), [{
        comm: "telegram",
        bot_user_id: "7777777777",
        sender_id: "1234",
        added_at: 1,
        added_by: undefined,
        note: undefined,
      }]);
      const conv = await verify.getConversation(conversationId);
      assert.equal(conv?.bot_user_id, "7777777777");
    } finally {
      await verify.close();
    }
  });

  it("rejects ambiguous label-based token updates", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-update-token-"));

    await accountAdd({
      project: "D:\\Projects\\claude",
      agent: "claude",
      accountLabel: "main",
      botToken: "claude-token",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });
    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    await assert.rejects(
      () => accountUpdateToken({
        comm: "telegram",
        accountLabel: "main",
        botToken: "new-token",
        stateRoot,
        probeIdentity: identity("8988792099", "sd_codex_bot"),
      }),
      (error: Error) => {
        assert.match(error.message, /ambiguous/);
        assert.match(error.message, /8950482517/);
        assert.match(error.message, /8988792099/);
        return true;
      },
    );
  });
});

function identity(bot_user_id: string, bot_username: string) {
  return async () => ({ bot_user_id, bot_username });
}

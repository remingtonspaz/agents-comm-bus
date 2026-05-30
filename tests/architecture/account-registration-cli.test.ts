import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { accountAdd } from "../../core-daemon/cli/account-add.js";
import { accountRemove } from "../../core-daemon/cli/account-remove.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { resolveStatePaths } from "../../core-daemon/paths.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("account registration CLI contract", () => {
  it("exposes explicit account subcommands without implicit registration wording", () => {
    const source = readFileSync(resolve(repoRoot, "core-daemon/cli/index.ts"), "utf8");

    assert.match(source, /account-add/);
    assert.match(source, /account-list/);
    assert.match(source, /account-remove/);
    assert.doesNotMatch(source, /implicit/i);
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

  it("honors explicit credentials refs without writing a default token file", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-add-"));

    const rec = await accountAdd({
      project: "D:\\Projects\\stonks",
      agent: "codex",
      accountLabel: "stonks codex dev",
      botToken: "secret-token",
      credentialsRef: "env:STONKS_CODEX_TELEGRAM_BOT_TOKEN",
      stateRoot,
      probeIdentity: async () => ({
        bot_user_id: "8743694023",
        bot_username: "sd_stonks_codex_dev_bot",
      }),
    });

    assert.equal(rec.credentials_ref, "env:STONKS_CODEX_TELEGRAM_BOT_TOKEN");
    assert.equal(existsSync(join(stateRoot, "tokens")), false);
  });

  it("rejects account-add when the bot id is already registered", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-add-"));

    await accountAdd({
      project: "D:\\Projects\\stonks",
      agent: "codex",
      accountLabel: "main",
      botToken: "secret-token",
      credentialsRef: "env:CODEX_TOKEN",
      stateRoot,
      probeIdentity: identity("8743694023", "sd_stonks_codex_dev_bot"),
    });

    await assert.rejects(
      () => accountAdd({
        project: "D:\\Projects\\other",
        agent: "claude",
        accountLabel: "main",
        botToken: "same-bot-token",
        credentialsRef: "env:CLAUDE_TOKEN",
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
      credentialsRef: "env:CODEX_TOKEN",
      stateRoot,
      probeIdentity: identity("8743694023", "sd_stonks_codex_dev_bot"),
    });

    await assert.rejects(
      () => accountAdd({
        project: "D:\\Projects\\stonks",
        agent: "codex",
        accountLabel: "main",
        botToken: "replacement-token",
        credentialsRef: "env:REPLACEMENT_TOKEN",
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
      credentialsRef: "env:CODEX_TOKEN",
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
      credentialsRef: "env:CLAUDE_TOKEN",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });
    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "codex-token",
      credentialsRef: "env:CODEX_TOKEN",
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
      credentialsRef: "env:CODEX_TOKEN",
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
});

function identity(bot_user_id: string, bot_username: string) {
  return async () => ({ bot_user_id, bot_username });
}

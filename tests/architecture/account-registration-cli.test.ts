import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { accountAdd } from "../../core-daemon/cli/account-add.js";

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
});

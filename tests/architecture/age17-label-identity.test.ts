// AGE-17: conversations now carry the concrete receiving bot id. These source
// checks pin the model-facing surfaces that previously leaked account_label as
// if it were a routing identity.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(import.meta.dirname, "../..");

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

describe("AGE-17 account identity surfaces", () => {
  it("agent prompt hooks expose account from chat.account and never fall back to account_label", async () => {
    for (const hook of [
      "hosts/claude/hooks/user-prompt-submit.js",
      "hosts/codex/hooks/user-prompt-submit.js",
    ]) {
      const text = await source(hook);
      assert.match(text, /account:\s*chat\.account/);
      assert.match(text, /account_label:\s*conversation\.account_label/);
      assert.doesNotMatch(text, /account:\s*chat\.account\s*\|\|/);
      assert.doesNotMatch(text, /account:\s*.*conversation\.account_label/);
    }
  });

  it("Codex steer context exposes the receiving bot id as account", async () => {
    const text = await source("core-daemon/bridges/codex/bridge.ts");
    assert.match(text, /`account=\$\{message\.chat\.account\}`/);
    assert.match(text, /`account_label=\$\{conversation\.account_label\}`/);
    assert.doesNotMatch(text, /`account=\$\{conversation\.account_label\}`/);
  });

  it("bridge origin chats prefer stored bot_user_id, then resolve by registration_id (no account_label fallback)", async () => {
    for (const bridge of [
      "core-daemon/bridges/claude/bridge.ts",
      "core-daemon/bridges/codex/bridge.ts",
    ]) {
      const text = await source(bridge);
      const botUserIdBranch = text.indexOf("if (conversation.bot_user_id)");
      const registrationLookup = text.indexOf("candidate.registration_id === conversation.registration_id");
      assert.notEqual(botUserIdBranch, -1, `${bridge} must check conversation.bot_user_id`);
      assert.notEqual(registrationLookup, -1, `${bridge} must resolve the registration by registration_id`);
      assert.ok(botUserIdBranch < registrationLookup, `${bridge} must prefer bot_user_id before the registration lookup`);
      // AGE-22: the legacy account_label fallback is gone — label is never identity.
      assert.doesNotMatch(
        text,
        /candidate\.account_label === conversation\.account_label/,
        `${bridge} must not fall back to account_label`,
      );
    }
  });
});

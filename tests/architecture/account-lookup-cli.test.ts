import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { accountAdd } from "../../core-daemon/cli/account-add.js";
import { accountLookup, formatAccountLookup } from "../../core-daemon/cli/account-lookup.js";

describe("account-lookup CLI", () => {
  it("reports a registered token with redacted registration and probed identity", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-lookup-"));

    await accountAdd({
      project: "D:\\Projects\\codex",
      agent: "codex",
      accountLabel: "main",
      botToken: "secret-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    const result = await accountLookup({
      botToken: "secret-token",
      stateRoot,
      probeIdentity: identity("8988792099", "sd_codex_bot"),
    });

    assert.equal(result.registered, true);
    assert.equal(result.bot_user_id, "8988792099");
    assert.equal(result.bot_username, "sd_codex_bot");
    assert.ok(result.registration);
    assert.equal(result.registration?.project, "D:\\Projects\\codex");
    assert.equal(result.registration?.agent, "codex");
    assert.equal(result.registration?.comm, "telegram");
    assert.equal(result.registration?.account_label, "main");
    assert.equal(result.registration?.credentials_ref, "[redacted]");
    assert.doesNotMatch(JSON.stringify(result), /file:/);
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  });

  it("reports probed identity when no registration matches", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-lookup-"));

    const result = await accountLookup({
      botToken: "unregistered-token",
      stateRoot,
      probeIdentity: identity("7777777777", "orphan_bot"),
    });

    assert.equal(result.registered, false);
    assert.equal(result.bot_user_id, "7777777777");
    assert.equal(result.bot_username, "orphan_bot");
    assert.equal(result.registration, null);
  });

  it("rejects missing bot token", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-lookup-"));

    await assert.rejects(
      () => accountLookup({ stateRoot }),
      (error: Error) => {
        assert.match(error.message, /--bot-token is required/);
        return true;
      },
    );
  });

  it("surfaces probe failures for invalid or unreachable tokens", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-lookup-"));

    await assert.rejects(
      () => accountLookup({
        botToken: "bad-token",
        stateRoot,
        probeIdentity: async () => {
          throw new Error("probe_comm_identity failed: unauthorized");
        },
      }),
      (error: Error) => {
        assert.match(error.message, /probe_comm_identity failed/);
        return true;
      },
    );
  });

  it("formats human-readable output with registration details", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-lookup-"));

    await accountAdd({
      project: "D:\\Projects\\claude",
      agent: "claude",
      accountLabel: "main",
      botToken: "claude-token",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });

    const result = await accountLookup({
      botToken: "claude-token",
      stateRoot,
      probeIdentity: identity("8950482517", "sd_claude_bot"),
    });

    const text = formatAccountLookup(result);
    assert.match(text, /registered: yes/);
    assert.match(text, /bot_user_id: 8950482517/);
    assert.match(text, /bot_username: sd_claude_bot/);
    assert.match(text, /project: D:\\Projects\\claude/);
    assert.match(text, /agent: claude/);
    assert.match(text, /comm: telegram/);
    assert.match(text, /account_label: main/);
    assert.doesNotMatch(text, /file:/);
    assert.doesNotMatch(text, /claude-token/);
  });

  it("formats human-readable output when unregistered", async () => {
    const stateRoot = await mkdtemp(join(os.tmpdir(), "agents-comm-account-lookup-"));

    const result = await accountLookup({
      botToken: "orphan-token",
      stateRoot,
      probeIdentity: identity("1111111111", "lonely_bot"),
    });

    const text = formatAccountLookup(result);
    assert.match(text, /registered: no/);
    assert.match(text, /bot_user_id: 1111111111/);
    assert.match(text, /bot_username: lonely_bot/);
    assert.doesNotMatch(text, /project:/);
    assert.doesNotMatch(text, /account_label:/);
  });
});

function identity(bot_user_id: string, bot_username: string) {
  return async (_credentials?: Record<string, unknown>) => ({ bot_user_id, bot_username });
}

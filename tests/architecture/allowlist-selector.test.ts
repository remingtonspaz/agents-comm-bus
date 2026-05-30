// AGE-17: per-bot allowlist selectors prefer concrete bot_user_id, while label
// selectors are accepted only when they resolve to one account.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  AccountRegistration,
  CommId,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import { resolvePerBotSelector } from "../../core-daemon/cli/allowlist-shared.js";

const TELEGRAM = "telegram" as CommId;
const repoRoot = resolve(import.meta.dirname, "../..");

describe("allowlist per-bot selector", () => {
  it("accepts --bot-id without consulting account labels", async () => {
    const storage = storageThatMustNotResolveLabels();

    const result = await resolvePerBotSelector(storage, {
      comm: TELEGRAM,
      botId: "8988792099",
      agent: "codex",
      project: "/repo",
      accountLabel: "main",
    });

    assert.deepEqual(result, { bot_user_id: "8988792099" });
  });

  it("accepts an explicit account label when it resolves to one registration", async () => {
    const row = account({ bot_user_id: "8988792099", agent: "codex" });
    const storage = storageWithAccounts([
      account({ bot_user_id: "8950482517", agent: "claude" }),
      row,
    ]);

    const result = await resolvePerBotSelector(storage, {
      comm: TELEGRAM,
      agent: "codex",
      accountLabel: "main",
    });

    assert.deepEqual(result, { bot_user_id: "8988792099", matched: row });
  });

  it("rejects ambiguous account labels and names candidate bot ids", async () => {
    const storage = storageWithAccounts([
      account({ bot_user_id: "8950482517", agent: "claude" }),
      account({ bot_user_id: "8988792099", agent: "codex" }),
    ]);

    await assert.rejects(
      () => resolvePerBotSelector(storage, {
        comm: TELEGRAM,
        accountLabel: "main",
      }),
      (error: Error) => {
        assert.match(error.message, /ambiguous/);
        assert.match(error.message, /8950482517/);
        assert.match(error.message, /8988792099/);
        assert.match(error.message, /--agent/);
        assert.match(error.message, /--project/);
        assert.match(error.message, /--bot-id/);
        return true;
      },
    );
  });

  it("rejects per-bot selectors with neither bot id nor account label", async () => {
    const storage = storageWithAccounts([]);

    await assert.rejects(
      () => resolvePerBotSelector(storage, {
        comm: TELEGRAM,
        agent: "codex",
      }),
      /requires --bot-id or --account-label/,
    );
  });

  it("CLI help documents bot-id as canonical and labels as unambiguous selectors", async () => {
    const source = await readFile(resolve(repoRoot, "core-daemon/cli/index.ts"), "utf8");
    assert.match(source, /--bot-id is canonical/);
    assert.match(source, /--account-label <label>/);
    assert.match(source, /resolve to exactly one account/);
  });
});

function storageThatMustNotResolveLabels(): Storage {
  return {
    async listAccountRegistrations() {
      throw new Error("label lookup should not be used for allowlist per-bot selection");
    },
  } as unknown as Storage;
}

function storageWithAccounts(rows: AccountRegistration[]): Storage {
  return {
    async listAccountRegistrations(filter) {
      return rows.filter((row) =>
        (filter?.project === undefined || row.project === filter.project) &&
        (filter?.comm === undefined || row.comm === filter.comm) &&
        (filter?.agent === undefined || row.agent === filter.agent)
      );
    },
  } as unknown as Storage;
}

function account(overrides: Partial<AccountRegistration>): AccountRegistration {
  return {
    schema_version: 1,
    project: "/repo",
    comm: TELEGRAM,
    agent: "codex",
    account_label: "main",
    bot_user_id: "8988792099",
    credentials_ref: "env:TOKEN",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

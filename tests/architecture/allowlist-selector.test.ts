// AGE-17: per-bot allowlist selectors must use concrete bot_user_id, not
// account labels or agent/project-scoped label lookup.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CommId, Storage } from "../../packages/core-contracts/src/index.js";
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

  it("rejects label-based scoped selectors for per-bot allowlist scope", async () => {
    const storage = storageThatMustNotResolveLabels();

    await assert.rejects(
      () => resolvePerBotSelector(storage, {
        comm: TELEGRAM,
        agent: "codex",
        project: "/repo",
        accountLabel: "main",
      }),
      (error: Error) => {
        assert.match(error.message, /requires --bot-id/);
        assert.match(error.message, /--agent/);
        assert.match(error.message, /--project/);
        assert.match(error.message, /--account-label/);
        assert.match(error.message, /account-list/);
        return true;
      },
    );
  });

  it("CLI help no longer advertises account-label resolution for per-bot allowlist commands", async () => {
    const source = await readFile(resolve(repoRoot, "core-daemon/cli/index.ts"), "utf8");
    assert.doesNotMatch(source, /per-bot \(resolved\)/);
    assert.doesNotMatch(source, /For per-bot scope without --bot-id/);
    assert.match(source, /Per-bot allowlist selectors require --bot-id/);
  });
});

function storageThatMustNotResolveLabels(): Storage {
  return {
    async listAccountRegistrations() {
      throw new Error("label lookup should not be used for allowlist per-bot selection");
    },
  } as unknown as Storage;
}

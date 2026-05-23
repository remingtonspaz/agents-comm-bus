import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("account registration CLI contract", () => {
  it("exposes explicit account subcommands without implicit registration wording", () => {
    const source = readFileSync(resolve(repoRoot, "core-daemon/cli/index.ts"), "utf8");

    assert.match(source, /account-add/);
    assert.match(source, /account-list/);
    assert.match(source, /account-remove/);
    assert.doesNotMatch(source, /implicit/i);
  });
});

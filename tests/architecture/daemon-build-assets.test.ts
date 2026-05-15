import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("agents-comm-bus build assets", () => {
  it("copies SQLite schema files into the built daemon artifact", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "agents-comm-bus/package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    assert.match(packageJson.scripts?.build ?? "", /copy-assets\.js/);

    const builtSchema = await readFile(
      resolve(repoRoot, "agents-comm-bus/dist/storage/schema/001_initial.sql"),
      "utf8",
    );
    assert.match(builtSchema, /CREATE TABLE IF NOT EXISTS account_registrations/);
    assert.match(builtSchema, /CREATE TABLE IF NOT EXISTS conversations/);
    assert.match(builtSchema, /CREATE TABLE IF NOT EXISTS sessions/);
  });
});

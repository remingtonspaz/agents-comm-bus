import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adapterBundleFileName,
  adapterBundlePathMatcher,
  adapterVersionRelPath,
  discoverCommAdapters,
} from "../../scripts/comm-adapters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("comm-adapters discovery", () => {
  it("discovers telegram as a shippable comm adapter", async () => {
    const comms = await discoverCommAdapters(repoRoot);
    assert.ok(comms.includes("telegram"), `expected telegram in ${JSON.stringify(comms)}`);
  });

  it("exposes stable path helpers for release tooling", () => {
    assert.equal(adapterVersionRelPath("telegram"), "adapters/telegram/version.ts");
    assert.equal(adapterBundleFileName("telegram"), "telegram.adapter.bundle.js");
    assert.ok(adapterBundlePathMatcher("telegram").test("plugins/claude/telegram/telegram.adapter.bundle.js"));
    assert.ok(!adapterBundlePathMatcher("telegram").test("plugins/claude/telegram/discord.adapter.bundle.js"));
  });
});

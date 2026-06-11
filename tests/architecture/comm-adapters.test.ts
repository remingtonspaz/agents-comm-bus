import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  adapterBundleFileName,
  adapterBundlePathMatcher,
  adapterVersionRelPath,
  discoverCommAdapters,
} from "../../scripts/comm-adapters.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("comm-adapters discovery", () => {
  it("discovers all shippable comm adapters", async () => {
    const comms = await discoverCommAdapters(repoRoot);
    assert.ok(comms.includes("telegram"), `expected telegram in ${JSON.stringify(comms)}`);
    assert.ok(comms.includes("matrix"), `expected matrix in ${JSON.stringify(comms)}`);
    assert.ok(comms.includes("discord"), `expected discord in ${JSON.stringify(comms)}`);
    assert.ok(comms.includes("curl"), `expected curl in ${JSON.stringify(comms)}`);
  });

  it("exposes stable path helpers for release tooling", () => {
    assert.equal(adapterVersionRelPath("telegram"), "adapters/telegram/version.ts");
    assert.equal(adapterBundleFileName("telegram"), "telegram.adapter.bundle.js");
    assert.ok(adapterBundlePathMatcher("telegram").test("plugins/claude/telegram/telegram.adapter.bundle.js"));
    assert.ok(!adapterBundlePathMatcher("telegram").test("plugins/claude/telegram/discord.adapter.bundle.js"));
  });

  it("throws loudly when an adapter dir has version.ts without factory.ts", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "comm-adapters-partial-"));
    const adapterDir = join(root, "adapters", "discord");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(join(adapterDir, "version.ts"), "export const ADAPTER_VERSION = '0.0.0';\n", "utf8");

    await assert.rejects(
      () => discoverCommAdapters(root),
      /adapters\/discord: partial comm adapter[\s\S]*missing factory\.ts/,
    );
  });

  it("throws loudly when an adapter dir has factory.ts without version.ts", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "comm-adapters-partial-"));
    const adapterDir = join(root, "adapters", "matrix");
    await mkdir(adapterDir, { recursive: true });
    await writeFile(join(adapterDir, "factory.ts"), "export {};\n", "utf8");

    await assert.rejects(
      () => discoverCommAdapters(root),
      /adapters\/matrix: partial comm adapter[\s\S]*missing version\.ts/,
    );
  });

  it("silently skips adapter-shaped dirs that contain neither version.ts nor factory.ts", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "comm-adapters-empty-"));
    await mkdir(join(root, "adapters", "notes"), { recursive: true });
    await writeFile(join(root, "adapters", "notes", "README.md"), "research only\n", "utf8");

    const comms = await discoverCommAdapters(root);
    assert.deepEqual(comms, []);
  });
});

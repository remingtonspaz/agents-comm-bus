import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  loadCommAdapterFactories,
  type CommAdapterLoadFailure,
} from "../../core-daemon/runtime/comm-adapter-loader.js";

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempAdaptersDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acb-loader-"));
  created.push(dir);
  // adapters dir is ESM (mirrors the central install's adapters/package.json).
  await writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n', "utf8");
  return dir;
}

function validFactorySource(commId: string): string {
  return `export function createCommAdapterFactory() {
  return {
    commId: ${JSON.stringify(commId)},
    async resolveCredentials() { return undefined; },
    create() { throw new Error("not used"); },
  };
}
`;
}

describe("comm adapter loader — graceful failure isolation (AGE-27)", () => {
  it("loads healthy adapters and skips broken ones without throwing", async () => {
    const dir = await tempAdaptersDir();
    await writeFile(path.join(dir, "good.js"), validFactorySource("good"), "utf8");
    // import-time throw
    await writeFile(path.join(dir, "boom.js"), 'throw new Error("import boom");\n', "utf8");
    // missing createCommAdapterFactory
    await writeFile(path.join(dir, "noexport.js"), "export const nope = 1;\n", "utf8");
    // invalid factory shape (no commId)
    await writeFile(
      path.join(dir, "badshape.js"),
      "export function createCommAdapterFactory() { return { create() {} }; }\n",
      "utf8",
    );

    const failures: CommAdapterLoadFailure[] = [];
    const factories = await loadCommAdapterFactories({
      adaptersDir: dir,
      onError: (f) => failures.push(f),
    });

    assert.deepEqual(
      factories.map((f) => f.commId),
      ["good"],
      "only the healthy adapter loaded",
    );
    assert.deepEqual(
      failures.map((f) => path.basename(f.modulePath)).sort(),
      ["badshape.js", "boom.js", "noexport.js"],
      "each broken adapter reported exactly once",
    );
  });

  it("returns [] and does not throw when every adapter fails, with a loud summary", async () => {
    const dir = await tempAdaptersDir();
    await writeFile(path.join(dir, "boom.js"), 'throw new Error("import boom");\n', "utf8");

    const failures: CommAdapterLoadFailure[] = [];
    const factories = await loadCommAdapterFactories({
      adaptersDir: dir,
      onError: (f) => failures.push(f),
    });

    assert.equal(factories.length, 0, "no adapters loaded");
    assert.ok(
      failures.some((f) => path.basename(f.modulePath) === "boom.js"),
      "the broken adapter was reported",
    );
    assert.ok(
      failures.some(
        (f) =>
          f.modulePath === dir &&
          /all failed/.test(f.error instanceof Error ? f.error.message : String(f.error)),
      ),
      "a loud all-failed summary was emitted keyed on the adapters dir",
    );
  });

  it("uses the default console logger without throwing when a bad adapter is present", async () => {
    const dir = await tempAdaptersDir();
    await writeFile(path.join(dir, "good.js"), validFactorySource("good"), "utf8");
    await writeFile(path.join(dir, "boom.js"), 'throw new Error("import boom");\n', "utf8");

    // No onError injected -> default console.error path must not reject.
    const factories = await loadCommAdapterFactories({ adaptersDir: dir });
    assert.deepEqual(factories.map((f) => f.commId), ["good"]);
  });

  it("returns [] for a missing adapters dir (no comms installed)", async () => {
    const factories = await loadCommAdapterFactories({
      adaptersDir: path.join(os.tmpdir(), "acb-loader-does-not-exist-zzz-9182"),
    });
    assert.deepEqual(factories, []);
  });
});

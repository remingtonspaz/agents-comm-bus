import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adapterBundlePathMatcher } from "../../scripts/comm-adapters.mjs";
import { evaluateVersionBump } from "../../scripts/check-version-bump-lib.mjs";

const DAEMON_SURFACE = {
  label: "daemon",
  versionFile: "core-daemon/config.ts",
  versionConst: "DAEMON_VERSION",
  match: (f: string) => /(^|\/)(daemon|cli)\.bundle\.js$/.test(f),
  bumpCmd: "npm run bump:daemon",
};

const TELEGRAM_SURFACE = {
  label: "telegram adapter",
  versionFile: "adapters/telegram/version.ts",
  versionConst: "ADAPTER_VERSION",
  match: (f: string) => adapterBundlePathMatcher("telegram").test(f),
  bumpCmd: "npm run bump:adapter -- telegram patch",
};

const DISCORD_SURFACE = {
  label: "discord adapter",
  versionFile: "adapters/discord/version.ts",
  versionConst: "ADAPTER_VERSION",
  match: (f: string) => adapterBundlePathMatcher("discord").test(f),
  bumpCmd: "npm run bump:adapter -- discord patch",
};

const SURFACES = [DAEMON_SURFACE, TELEGRAM_SURFACE, DISCORD_SURFACE];

function versionFileContent(version: string, constName: string): string {
  return `export const ${constName} = "${version}";\n`;
}

describe("check-version-bump first-ship semantics", () => {
  it("passes when only new bundle paths were added at the current version", () => {
    const filesAtBase = new Map<string, string>([
      ["core-daemon/config.ts", versionFileContent("0.2.14", "DAEMON_VERSION")],
      ["adapters/discord/version.ts", versionFileContent("0.1.0", "ADAPTER_VERSION")],
      ["adapters/telegram/version.ts", versionFileContent("0.1.3", "ADAPTER_VERSION")],
    ]);
    const filesAtHead = new Map(filesAtBase);
    filesAtHead.set("core-daemon/config.ts", versionFileContent("0.2.14", "DAEMON_VERSION"));
    filesAtHead.set("adapters/discord/version.ts", versionFileContent("0.1.0", "ADAPTER_VERSION"));

    const fileAtRef = (ref: string, file: string) => {
      const store = ref === "base" ? filesAtBase : filesAtHead;
      return store.get(file) ?? null;
    };

    const failures = evaluateVersionBump({
      changed: [
        "plugins/claude/discord/daemon.bundle.js",
        "plugins/claude/discord/cli.bundle.js",
        "plugins/claude/discord/discord.adapter.bundle.js",
      ],
      baseRef: "base",
      surfaces: SURFACES,
      fileAtRef,
    });

    assert.deepEqual(failures, []);
  });

  it("still demands a bump when a new path is added alongside a modified pre-existing bundle", () => {
    const filesAtBase = new Map<string, string>([
      ["core-daemon/config.ts", versionFileContent("0.2.14", "DAEMON_VERSION")],
      ["adapters/telegram/version.ts", versionFileContent("0.1.3", "ADAPTER_VERSION")],
      ["plugins/claude/telegram/telegram.adapter.bundle.js", "telegram-bundle-v1"],
    ]);
    const filesAtHead = new Map(filesAtBase);
    filesAtHead.set("plugins/claude/telegram/telegram.adapter.bundle.js", "telegram-bundle-v2");

    const fileAtRef = (ref: string, file: string) => {
      const store = ref === "base" ? filesAtBase : filesAtHead;
      return store.get(file) ?? null;
    };

    const failures = evaluateVersionBump({
      changed: [
        "plugins/claude/discord/discord.adapter.bundle.js",
        "plugins/claude/telegram/telegram.adapter.bundle.js",
      ],
      baseRef: "base",
      surfaces: SURFACES,
      fileAtRef,
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.label, "telegram adapter");
    assert.deepEqual(failures[0]!.files, ["plugins/claude/telegram/telegram.adapter.bundle.js"]);
  });

  it("still demands a daemon bump when a pre-existing daemon bundle path changes", () => {
    const filesAtBase = new Map<string, string>([
      ["core-daemon/config.ts", versionFileContent("0.2.14", "DAEMON_VERSION")],
      ["plugins/claude/telegram/daemon.bundle.js", "daemon-bundle-v1"],
    ]);
    const filesAtHead = new Map(filesAtBase);
    filesAtHead.set("plugins/claude/telegram/daemon.bundle.js", "daemon-bundle-v2");

    const fileAtRef = (ref: string, file: string) => {
      const store = ref === "base" ? filesAtBase : filesAtHead;
      return store.get(file) ?? null;
    };

    const failures = evaluateVersionBump({
      changed: [
        "plugins/claude/discord/daemon.bundle.js",
        "plugins/claude/telegram/daemon.bundle.js",
      ],
      baseRef: "base",
      surfaces: [DAEMON_SURFACE],
      fileAtRef,
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.label, "daemon");
    assert.deepEqual(failures[0]!.files, ["plugins/claude/telegram/daemon.bundle.js"]);
  });

  it("uses the existence probe instead of reading pre-existing bundle contents", () => {
    const bundlePath = "plugins/claude/discord/discord.adapter.bundle.js";
    const filesAtBase = new Map<string, string>([
      ["adapters/discord/version.ts", versionFileContent("0.1.0", "ADAPTER_VERSION")],
      [bundlePath, "x".repeat(1_100_000)],
    ]);
    const filesAtHead = new Map(filesAtBase);

    const fileAtRef = (ref: string, file: string) => {
      if (file === bundlePath) {
        throw new Error("bundle contents should not be read for existence checks");
      }
      const store = ref === "base" ? filesAtBase : filesAtHead;
      return store.get(file) ?? null;
    };
    const fileExistsAtRef = (ref: string, file: string) => {
      const store = ref === "base" ? filesAtBase : filesAtHead;
      return store.has(file);
    };

    const failures = evaluateVersionBump({
      changed: [bundlePath],
      baseRef: "base",
      surfaces: [DISCORD_SURFACE],
      fileAtRef,
      fileExistsAtRef,
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.label, "discord adapter");
    assert.deepEqual(failures[0]!.files, [bundlePath]);
  });
});

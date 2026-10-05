import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildProcessChainFromSnapshot,
  findCmdAncestor,
  findClaudeOwnerPid,
  parseProcessSnapshotLines,
  resolveClaudeOwnerPidCached,
} from "../../hosts/claude/hooks/wake-support.js";

const OWNER_PID_CACHE_TTL_MS = 5 * 60 * 1000;

function snapshotRows(
  rows: Array<{ pid: number; parentPid: number; name: string }>,
): ReturnType<typeof parseProcessSnapshotLines> {
  const text = rows.map((r) => `${r.pid}:${r.parentPid}:${r.name}`).join("\n");
  return parseProcessSnapshotLines(text);
}

describe("AGE-113 snapshot parser + chain builder", () => {
  it("herdr-shaped table walks node hook up to claude.exe", () => {
    const rows = snapshotRows([
      { pid: 9000, parentPid: 8000, name: "node.exe" },
      { pid: 8000, parentPid: 7000, name: "bash.exe" },
      { pid: 7000, parentPid: 6000, name: "bash.exe" },
      { pid: 6000, parentPid: 5000, name: "bash.exe" },
      { pid: 5000, parentPid: 4000, name: "claude.exe" },
      { pid: 4000, parentPid: 3000, name: "powershell.exe" },
      { pid: 3000, parentPid: 0, name: "herdr.exe" },
    ]);
    const chain = buildProcessChainFromSnapshot(rows, 9000);
    assert.deepEqual(
      chain.map((c) => `${c.name}#${c.pid}`),
      [
        "node.exe#9000",
        "bash.exe#8000",
        "bash.exe#7000",
        "bash.exe#6000",
        "claude.exe#5000",
        "powershell.exe#4000",
        "herdr.exe#3000",
      ],
    );
  });

  it("missing parent stops the walk without throw", () => {
    const rows = snapshotRows([{ pid: 10, parentPid: 99, name: "node.exe" }]);
    const chain = buildProcessChainFromSnapshot(rows, 10);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].pid, 10);
  });

  it("cycle in parent links terminates", () => {
    const rows = snapshotRows([
      { pid: 1, parentPid: 2, name: "a.exe" },
      { pid: 2, parentPid: 1, name: "b.exe" },
    ]);
    const chain = buildProcessChainFromSnapshot(rows, 1);
    assert.deepEqual(
      chain.map((c) => c.pid),
      [1, 2],
    );
  });
});

describe("AGE-113 findCmdAncestor herdr fast path", () => {
  it("HERDR_ENV=1 returns null without calling the chain reader", () => {
    let readCalls = 0;
    const result = findCmdAncestor(() => {}, {
      platform: "win32",
      env: { HERDR_ENV: "1" },
      readChain: () => {
        readCalls += 1;
        return { pid: 1, claudePid: 2, hwnd: null };
      },
    });
    assert.equal(result, null);
    assert.equal(readCalls, 0);
  });
});

describe("AGE-113 ensureClaudeWakeWatcherAfterRegister herdr", () => {
  it("HERDR_ENV=1 skips ensureClaudeWakeWatcher even when lease is already held", async () => {
    const { ensureClaudeWakeWatcherAfterRegister } = await import(
      "../../hosts/common/claude-wake-after-register.js"
    );
    let ensureCalls = 0;
    ensureClaudeWakeWatcherAfterRegister(
      { ok: false, reason: "same-project claude session lease already held" },
      { log: () => {} },
      {
        env: { HERDR_ENV: "1" },
        ensureClaudeWakeWatcher: () => {
          ensureCalls += 1;
        },
      },
    );
    assert.equal(ensureCalls, 0);
  });

  it("without HERDR_ENV still calls ensureClaudeWakeWatcher on lease-held register", async () => {
    const { ensureClaudeWakeWatcherAfterRegister } = await import(
      "../../hosts/common/claude-wake-after-register.js"
    );
    let ensureCalls = 0;
    ensureClaudeWakeWatcherAfterRegister(
      { ok: false, reason: "same-project claude session lease already held" },
      { log: () => {} },
      {
        env: {},
        ensureClaudeWakeWatcher: () => {
          ensureCalls += 1;
        },
      },
    );
    assert.equal(ensureCalls, 1);
  });
});

describe("AGE-113 findClaudeOwnerPid herdr skip cmd walk", () => {
  it("HERDR_ENV=1 returns claude pid without calling findCmdAncestor", () => {
    let cmdCalls = 0;
    const chain = [
      { pid: 9000, name: "node.exe" },
      { pid: 5000, name: "claude.exe" },
    ];
    const pid = findClaudeOwnerPid(() => {}, {
      platform: "win32",
      env: { HERDR_ENV: "1" },
      findCmdAncestor: () => {
        cmdCalls += 1;
        return { pid: 1, claudePid: 9999, hwnd: null };
      },
      readChainRaw: () => chain,
    });
    assert.equal(pid, 5000);
    assert.equal(cmdCalls, 0);
  });
});

describe("AGE-113 native cmd->claude chain without HERDR_ENV", () => {
  it("findCmdAncestor finds cmd.exe whose child is claude.exe", () => {
    const rows = snapshotRows([
      { pid: 100, parentPid: 200, name: "node.exe" },
      { pid: 200, parentPid: 300, name: "claude.exe" },
      { pid: 300, parentPid: 400, name: "cmd.exe" },
      { pid: 400, parentPid: 0, name: "explorer.exe" },
    ]);
    const chain = buildProcessChainFromSnapshot(rows, 100);
    const result = findCmdAncestor(() => {}, {
      platform: "win32",
      env: {},
      backoffMs: [0],
      readChain: () => {
        for (let i = 1; i < chain.length; i += 1) {
          if (chain[i].name === "cmd.exe" && chain[i - 1].name === "claude.exe") {
            return { pid: chain[i].pid, hwnd: null, claudePid: chain[i - 1].pid };
          }
        }
        return null;
      },
    });
    assert.deepEqual(result, { pid: 300, hwnd: null, claudePid: 200 });
  });

  it("findClaudeOwnerPid prefers cmd ancestor claudePid when not herdr", () => {
    const pid = findClaudeOwnerPid(() => {}, {
      platform: "win32",
      env: {},
      findCmdAncestor: () => ({ pid: 300, claudePid: 200, hwnd: null }),
      readChainRaw: () => {
        throw new Error("chain fallback should not run when cmd resolves");
      },
    });
    assert.equal(pid, 200);
  });
});

describe("AGE-113 resolveClaudeOwnerPidCached", () => {
  function tempCacheDir() {
    return mkdtempSync(path.join(os.tmpdir(), "age113-owner-cache-"));
  }

  it("fresh alive cache hit skips resolve", () => {
    const dir = tempCacheDir();
    const cachePath = path.join(dir, "cache.json");
    writeFileSync(cachePath, JSON.stringify({ pid: 4242, resolvedAt: 1_000_000 }), "utf8");
    let resolves = 0;
    const pid = resolveClaudeOwnerPidCached({
      session: "sess-a",
      deps: {
        cachePath,
        now: () => 1_000_000 + 60_000,
        pidAlive: () => true,
        resolve: () => {
          resolves += 1;
          return 1111;
        },
      },
    });
    assert.equal(pid, 4242);
    assert.equal(resolves, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("expired cache re-resolves", () => {
    const dir = tempCacheDir();
    const cachePath = path.join(dir, "cache.json");
    writeFileSync(cachePath, JSON.stringify({ pid: 4242, resolvedAt: 0 }), "utf8");
    let resolves = 0;
    const pid = resolveClaudeOwnerPidCached({
      session: "sess-b",
      deps: {
        cachePath,
        now: () => OWNER_PID_CACHE_TTL_MS + 10,
        pidAlive: () => true,
        resolve: () => {
          resolves += 1;
          return 7777;
        },
      },
    });
    assert.equal(pid, 7777);
    assert.equal(resolves, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dead pid re-resolves", () => {
    const dir = tempCacheDir();
    const cachePath = path.join(dir, "cache.json");
    writeFileSync(cachePath, JSON.stringify({ pid: 4242, resolvedAt: 1_000_000 }), "utf8");
    let resolves = 0;
    const pid = resolveClaudeOwnerPidCached({
      session: "sess-c",
      deps: {
        cachePath,
        now: () => 1_000_000 + 1000,
        pidAlive: () => false,
        resolve: () => {
          resolves += 1;
          return 8888;
        },
      },
    });
    assert.equal(pid, 8888);
    assert.equal(resolves, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("corrupt cache re-resolves without throw", () => {
    const dir = tempCacheDir();
    const cachePath = path.join(dir, "not-json");
    writeFileSync(cachePath, "{broken", "utf8");
    let resolves = 0;
    const pid = resolveClaudeOwnerPidCached({
      session: "sess-d",
      deps: {
        cachePath,
        now: () => Date.now(),
        pidAlive: () => true,
        resolve: () => {
          resolves += 1;
          return 3333;
        },
      },
    });
    assert.equal(pid, 3333);
    assert.equal(resolves, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("cache write failure still returns resolved pid", () => {
    const failingFs = {
      readFileSync: () => {
        throw new Error("ENOENT");
      },
      mkdirSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {
        throw new Error("EACCES");
      },
      renameSync: () => {
        throw new Error("EACCES");
      },
    };
    const pid = resolveClaudeOwnerPidCached({
      session: "sess-e",
      deps: {
        fs: failingFs,
        cachePath: path.join(os.tmpdir(), "agents-comm-bus-claude-owner", "x.json"),
        resolve: () => 5555,
      },
    });
    assert.equal(pid, 5555);
  });
});

describe("AGE-113 chain shape for walk helpers", () => {
  it("buildProcessChainFromSnapshot returns [{pid,name}] from self upward", () => {
    const rows = snapshotRows([{ pid: 5, parentPid: 0, name: "Claude.EXE" }]);
    const chain = buildProcessChainFromSnapshot(rows, 5);
    assert.deepEqual(chain, [{ pid: 5, name: "claude.exe" }]);
  });
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ensureClaudeWakeWatcher } from "../../hosts/claude/hooks/wake-support.js";

// AGE-79: watcher-singleton fix + correctness hardening.
//  - poison-history: dedup off structured watcher.json, never the debug.log grep.
//  - B1: fail-closed identity, evaluated FIRST for any alive recorded pid (NOT
//        gated on metadata, so pre-fix/migration watchers can't fail open); a
//        transient CIM failure ('' cmd) => 'unverifiable' => no spawn / no kill;
//        a verified-ours pre-fix watcher is ADOPTED (metadata written) + reused;
//        identity uses an EXACT -SessionDir match (no prefix collision).
//  - B2: atomic single-consumer trigger claim (one trigger -> one send).
//  - B3: transactional pid+meta — watcher.json commits before watcher.pid is
//        advanced; on meta failure the owned new pid is killed directly and the
//        prior record is preserved (or the new pid recorded if kill fails).
// The spawn path is win32-only; those cases skip elsewhere.
const win32 = os.platform() === "win32";
const repoRoot = path.resolve(import.meta.dirname, "../..");

function tempWakeDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "wake-singleton-"));
}

// A command line watcherIdentity accepts as 'ours' with a real target.
function watcherCmd(sessionDir: string): string {
  return `"powershell.exe" -File D:\\repo\\scripts\\enter-watcher.ps1 -SessionDir ${sessionDir} -WindowHandle 200 -ClaudePid 50`;
}

// 'ours' but targetless (no -ClaudePid) — a zombie that must be replaced.
function targetlessWatcherCmd(sessionDir: string): string {
  return `"powershell.exe" -File D:\\repo\\scripts\\enter-watcher.ps1 -SessionDir ${sessionDir} -WindowHandle 200`;
}

function writePid(wakeDir: string, pid: number): void {
  writeFileSync(path.join(wakeDir, "watcher.pid"), `${pid}\n`, "utf8");
}

function seedWatcher(
  wakeDir: string,
  meta: { pid: number; claudePid: number; hwnd?: number | null } | null,
  opts: { poisonDebugLog?: boolean } = {},
): void {
  if (meta) {
    writePid(wakeDir, meta.pid);
    writeFileSync(
      path.join(wakeDir, "watcher.json"),
      `${JSON.stringify({ pid: meta.pid, claudePid: meta.claudePid, hwnd: meta.hwnd ?? null })}\n`,
      "utf8",
    );
  }
  if (opts.poisonDebugLog) {
    writeFileSync(
      path.join(wakeDir, "debug.log"),
      "[2026-06-20 13:15:26]   ClaudePid=0\n[2026-07-19 09:00:00]   Watcher started\n",
      "utf8",
    );
  }
}

describe("AGE-79 wake-watcher singleton", () => {
  it("reuses a live targeted watcher even when debug.log has a stale ClaudePid=0 line", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    seedWatcher(wakeDir, { pid: 1111, claudePid: 50, hwnd: 200 }, { poisonDebugLog: true });
    let spawnCalled = false;

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: () => watcherCmd(wakeDir),
      spawnWatcher: () => {
        spawnCalled = true;
        return 2222;
      },
    });

    assert.equal(result.started, false, "must reuse, not spawn");
    assert.equal(result.reason, "already_running");
    assert.equal(result.pid, 1111);
    assert.equal(spawnCalled, false, "stale ClaudePid=0 in history must NOT force a re-spawn");
  });

  it("ADOPTS a verified pre-fix watcher (no watcher.json): reuse + write metadata, no spawn/kill", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    writePid(wakeDir, 1111); // pre-fix: watcher.pid but NO watcher.json
    let spawnCalled = false;
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: () => watcherCmd(wakeDir),
      spawnWatcher: () => {
        spawnCalled = true;
        return 2222;
      },
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.started, false, "verified pre-fix watcher is adopted + reused, not replaced");
    assert.equal(result.reason, "already_running");
    assert.equal(spawnCalled, false, "no spawn");
    assert.equal(killed.length, 0, "no kill");
    const meta = JSON.parse(readFileSync(path.join(wakeDir, "watcher.json"), "utf8"));
    assert.equal(meta.pid, 1111, "metadata adopted for the existing watcher");
    assert.equal(meta.claudePid, 50);
  });

  it("is a steady-state singleton: spawn once (no existing), then repeated calls reuse", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir(); // no watcher.pid yet
    let spawns = 0;
    const alive = new Set<number>();
    const call = () =>
      ensureClaudeWakeWatcher({
        wakeDir,
        cmdInfo: { hwnd: 200, claudePid: 50 },
        isPidAlive: (pid) => alive.has(pid),
        readProcessCommandLine: () => watcherCmd(wakeDir),
        spawnWatcher: () => {
          spawns += 1;
          alive.add(2222);
          return 2222;
        },
        killWatcher: (pid) => alive.delete(pid),
      });

    const first = call();
    assert.equal(first.started, true, "first call spawns (no existing watcher)");
    const second = call();
    const third = call();
    assert.equal(second.started, false, "second call reuses");
    assert.equal(third.started, false, "third call reuses");
    assert.equal(spawns, 1, "exactly one watcher spawned across repeated calls");
  });

  it("replaces a targetless zombie (our watcher but no -ClaudePid)", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    writePid(wakeDir, 1111);
    let spawnCalled = false;

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: (pid) => (pid === 1111 ? targetlessWatcherCmd(wakeDir) : watcherCmd(wakeDir)),
      spawnWatcher: () => {
        spawnCalled = true;
        return 3333;
      },
      killWatcher: () => {},
    });

    assert.equal(spawnCalled, true, "a targetless watcher is a zombie and must be replaced");
    assert.equal(result.started, true);
    assert.equal(result.pid, 3333);
  });

  it("B1: never reuses OR kills a reused/foreign PID", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    seedWatcher(wakeDir, { pid: 1111, claudePid: 50, hwnd: 200 });
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: (pid) =>
        pid === 1111 ? "C:\\Windows\\System32\\notepad.exe" : watcherCmd(wakeDir),
      spawnWatcher: () => 2222,
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.started, true, "a foreign pid is not reusable => must spawn");
    assert.equal(result.pid, 2222);
    assert.equal(killed.includes(1111), false, "must NOT kill a reused/foreign PID");
  });

  it("B1 fail-closed (with metadata): unverifiable identity does NOT spawn or kill", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    seedWatcher(wakeDir, { pid: 1111, claudePid: 50, hwnd: 200 });
    let spawns = 0;
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: () => "",
      spawnWatcher: () => {
        spawns += 1;
        return 2222;
      },
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.started, false);
    assert.equal(result.reason, "identity_unverifiable");
    assert.equal(spawns, 0);
    assert.equal(killed.length, 0);
  });

  it("B1 fail-closed MIGRATION (pre-fix pid, NO watcher.json): unverifiable does NOT spawn or kill", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    writePid(wakeDir, 1111); // live watcher.pid, no watcher.json — first AGE-79 hook
    let spawns = 0;
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: () => "", // transient CIM failure on the first hook
      spawnWatcher: () => {
        spawns += 1;
        return 2222;
      },
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.reason, "identity_unverifiable", "no metadata must NOT bypass the fail-closed guard");
    assert.equal(spawns, 0, "migration + transient CIM failure must NOT spawn a duplicate");
    assert.equal(killed.length, 0);
  });

  it("B1 exact-match: a prefix-colliding SessionDir is neither reused nor killed", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    writePid(wakeDir, 1111);
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: (pid) =>
        pid === 1111 ? watcherCmd(`${wakeDir}-other`) : watcherCmd(wakeDir),
      spawnWatcher: () => 2222,
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.started, true, "prefix-colliding watcher is foreign => must spawn");
    assert.equal(killed.includes(1111), false, "must NOT kill a prefix-colliding foreign watcher");
  });

  it("B3 transactional: meta fails + kill succeeds => owned new pid killed, no record written", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir(); // no prior record
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: () => "",
      spawnWatcher: () => 2222,
      writeWatcherMeta: () => {
        throw new Error("disk full");
      },
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.reason, "meta_write_failed");
    assert.equal(killed.includes(2222), true, "owned just-spawned pid killed directly");
    assert.equal(existsSync(path.join(wakeDir, "watcher.pid")), false, "no partial pid record (kill succeeded)");
    assert.equal(existsSync(path.join(wakeDir, "watcher.json")), false, "no metadata committed");
  });

  it("B3 transactional: meta fails + kill FAILS => new pid recorded so it stays discoverable (not untracked)", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      readProcessCommandLine: () => "",
      spawnWatcher: () => 2222,
      writeWatcherMeta: () => {
        throw new Error("disk full");
      },
      killWatcher: () => {
        throw new Error("access denied");
      },
    });

    assert.equal(result.reason, "meta_write_failed");
    assert.equal(
      readFileSync(path.join(wakeDir, "watcher.pid"), "utf8").trim(),
      "2222",
      "a live-but-unkillable new watcher is recorded, not left untracked",
    );
  });

  it("B3 transactional: replacement + meta failure PRESERVES the prior pid record", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    writePid(wakeDir, 1111); // prior record
    const killed: number[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      isPidAlive: () => true,
      // prior 1111 is a zombie (targetless) so it is replaced; new 2222 is ours.
      readProcessCommandLine: (pid) => (pid === 1111 ? targetlessWatcherCmd(wakeDir) : watcherCmd(wakeDir)),
      spawnWatcher: () => 2222,
      writeWatcherMeta: () => {
        throw new Error("disk full");
      },
      killWatcher: (pid) => killed.push(pid),
    });

    assert.equal(result.reason, "meta_write_failed");
    assert.equal(killed.includes(2222), true, "the owned new pid is terminated");
    assert.equal(
      readFileSync(path.join(wakeDir, "watcher.pid"), "utf8").trim(),
      "1111",
      "the prior authoritative pid record is preserved (not overwritten/deleted)",
    );
  });

  it("split-brain: watcher.pid mirror-write failure on initial spawn keeps the watcher discoverable via watcher.json", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir(); // no prior
    let spawns = 0;
    const alive = new Set<number>();
    const call = () =>
      ensureClaudeWakeWatcher({
        wakeDir,
        cmdInfo: { hwnd: 200, claudePid: 50 },
        isPidAlive: (pid) => alive.has(pid),
        readProcessCommandLine: () => watcherCmd(wakeDir),
        spawnWatcher: () => {
          spawns += 1;
          alive.add(2222);
          return 2222;
        },
        // watcher.json commits, but the legacy watcher.pid mirror write throws.
        writeWatcherPid: () => {
          throw new Error("EPERM");
        },
        killWatcher: (pid) => alive.delete(pid),
      });

    const first = call();
    assert.equal(first.started, true, "spawn succeeds despite the mirror-write failure (not spawn_error)");
    const meta = JSON.parse(readFileSync(path.join(wakeDir, "watcher.json"), "utf8"));
    assert.equal(meta.pid, 2222, "watcher.json (authoritative) points at the new watcher");
    const second = call();
    assert.equal(second.started, false, "next hook discovers the new watcher via watcher.json => reuse");
    assert.equal(spawns, 1, "no untracked watcher; exactly one spawn");
  });

  it("split-brain: mirror-write failure on REPLACEMENT keeps the new watcher discoverable, no duplicate", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    // Prior record is a targetless zombie => replaced.
    writeFileSync(
      path.join(wakeDir, "watcher.json"),
      `${JSON.stringify({ pid: 1111, claudePid: 0, hwnd: null })}\n`,
      "utf8",
    );
    writePid(wakeDir, 1111);
    let spawns = 0;
    const alive = new Set<number>([1111]);
    const call = () =>
      ensureClaudeWakeWatcher({
        wakeDir,
        cmdInfo: { hwnd: 200, claudePid: 50 },
        isPidAlive: (pid) => alive.has(pid),
        readProcessCommandLine: (pid) => (pid === 1111 ? targetlessWatcherCmd(wakeDir) : watcherCmd(wakeDir)),
        spawnWatcher: () => {
          spawns += 1;
          alive.add(2222);
          return 2222;
        },
        writeWatcherPid: () => {
          throw new Error("EBUSY");
        },
        killWatcher: (pid) => alive.delete(pid),
      });

    const first = call();
    assert.equal(first.started, true, "replacement spawn succeeds despite the mirror-write failure");
    const meta = JSON.parse(readFileSync(path.join(wakeDir, "watcher.json"), "utf8"));
    assert.equal(meta.pid, 2222, "watcher.json now authoritative for the replacement");
    const second = call();
    assert.equal(second.started, false, "next hook reuses the new watcher via watcher.json; no duplicate");
    assert.equal(spawns, 1, "exactly one replacement spawn; new watcher never untracked");
  });

  it("B3 emergency: replacement + meta fail + kill fail drops stale JSON so the live new pid is discoverable", { skip: !win32 }, () => {
    const wakeDir = tempWakeDir();
    // Old targetless zombie recorded in BOTH watcher.json AND watcher.pid.
    writeFileSync(
      path.join(wakeDir, "watcher.json"),
      `${JSON.stringify({ pid: 1111, claudePid: 0, hwnd: null })}\n`,
      "utf8",
    );
    writePid(wakeDir, 1111);
    let spawns = 0;
    const alive = new Set<number>([1111]);
    const call = () =>
      ensureClaudeWakeWatcher({
        wakeDir,
        cmdInfo: { hwnd: 200, claudePid: 50 },
        isPidAlive: (pid) => alive.has(pid),
        readProcessCommandLine: (pid) => (pid === 1111 ? targetlessWatcherCmd(wakeDir) : watcherCmd(wakeDir)),
        spawnWatcher: () => {
          spawns += 1;
          alive.add(2222); // 2222 spawned...
          return 2222;
        },
        writeWatcherMeta: () => {
          throw new Error("disk full");
        },
        killWatcher: () => {
          throw new Error("access denied"); // ...and cannot be killed, so it stays live
        },
      });

    const first = call();
    assert.equal(first.reason, "meta_write_failed");
    assert.equal(existsSync(path.join(wakeDir, "watcher.json")), false, "stale prior metadata dropped");
    assert.equal(readFileSync(path.join(wakeDir, "watcher.pid"), "utf8").trim(), "2222", "live new pid mirrored");

    const second = call();
    assert.equal(second.started, false, "next ensure discovers/adopts/reuses the live new pid, not the dead old one");
    assert.equal(spawns, 1, "the unkillable new watcher must NOT be resurrected into a duplicate");
  });

  it("B2: an atomic rename claim yields exactly one winner among concurrent consumers", () => {
    const wakeDir = tempWakeDir();
    const trigger = path.join(wakeDir, "trigger-enter");
    writeFileSync(trigger, "", "utf8");
    let wins = 0;
    let misses = 0;
    for (const pid of [101, 102, 103, 104]) {
      try {
        renameSync(trigger, `${trigger}.${pid}.claim`);
        wins += 1;
      } catch {
        misses += 1;
      }
    }
    assert.equal(wins, 1, "exactly one consumer claims the single trigger");
    assert.equal(misses, 3, "the rest miss because the source was already moved");
  });

  it("B2: enter-watcher.ps1 consumes the trigger via an atomic Move-Item claim (not Test-Path+Remove-Item)", () => {
    const src = readFileSync(path.join(repoRoot, "scripts/enter-watcher.ps1"), "utf8");
    assert.match(src, /Move-Item[^\n]*\$triggerFile[^\n]*\$claimFile/i, "atomic Move-Item claim present");
    assert.match(src, /\$claimedTrigger/, "send is gated on the atomic claim result");
    assert.ok(!src.includes("Remove trigger file first"), "old non-atomic loop removal is gone");
  });
});

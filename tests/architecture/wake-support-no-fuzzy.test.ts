import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ensureClaudeWakeWatcher } from "../../hosts/claude/hooks/wake-support.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function tempWakeDir() {
  return mkdtempSync(path.join(os.tmpdir(), "wake-support-test-"));
}

describe("wake-support no fuzzy fallback (AGE-70)", () => {
  it("cmdInfo null: does not spawn, returns no_cmd_ancestor", () => {
    const wakeDir = tempWakeDir();
    const logs: string[] = [];
    let spawnCalled = false;

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: null,
      log: (msg) => logs.push(msg),
      spawnWatcher: () => {
        spawnCalled = true;
        return 9999;
      },
    });

    assert.equal(result.started, false);
    assert.equal(result.reason, "no_cmd_ancestor");
    assert.equal(spawnCalled, false);
    assert.ok(logs.some((line) => line.includes("no cmd ancestor resolved")));
    assert.ok(!logs.some((line) => line.includes("target=search")));
  });

  it("cmdInfo without hwnd or pid: does not spawn", () => {
    const wakeDir = tempWakeDir();
    let spawnCalled = false;

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { claudePid: 50 },
      spawnWatcher: () => {
        spawnCalled = true;
        return 9999;
      },
    });

    assert.equal(result.started, false);
    assert.equal(result.reason, "no_cmd_ancestor");
    assert.equal(spawnCalled, false);
  });

  it("precise hwnd path still spawns with -WindowHandle", () => {
    const wakeDir = tempWakeDir();
    const commands: string[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      spawnWatcher: (command) => {
        commands.push(command);
        return 4242;
      },
    });

    assert.equal(result.started, true);
    assert.equal(result.pid, 4242);
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /-WindowHandle.*'200'/);
    assert.match(commands[0]!, /-ClaudePid.*'50'/);
  });

  it("precise pid path with null hwnd still spawns with -TargetPid", () => {
    const wakeDir = tempWakeDir();
    const commands: string[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { pid: 100, hwnd: null, claudePid: 50 },
      spawnWatcher: (command) => {
        commands.push(command);
        return 4343;
      },
    });

    assert.equal(result.started, true);
    assert.equal(result.pid, 4343);
    assert.equal(commands.length, 1);
    assert.match(commands[0]!, /-TargetPid.*'100'/);
    assert.match(commands[0]!, /-ClaudePid.*'50'/);
    assert.doesNotMatch(commands[0]!, /-WindowHandle/);
  });

  it("invalid spawn pid: returns invalid_pid without throwing (no out-of-scope stdout)", () => {
    const wakeDir = tempWakeDir();
    const logs: string[] = [];

    const result = ensureClaudeWakeWatcher({
      wakeDir,
      cmdInfo: { hwnd: 200, claudePid: 50 },
      log: (msg) => logs.push(msg),
      spawnWatcher: () => NaN,
    });

    assert.equal(result.started, false);
    assert.equal(result.reason, "invalid_pid");
    assert.ok(logs.some((line) => line.includes("invalid pid")));
  });

  it("enter-watcher.ps1 has no broad title fuzzy search heuristic", () => {
    const src = readFileSync(path.join(repoRoot, "scripts/enter-watcher.ps1"), "utf8");
    assert.ok(!src.includes("Search mode fallback"));
    assert.ok(!/title -match '\^[^a-zA-Z]'/.test(src));
    assert.ok(!/title -match 'claude'/.test(src));
  });
});

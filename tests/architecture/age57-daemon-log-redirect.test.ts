import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  daemonSpawnStdio,
  daemonStderrLogPath,
} from "../../core-daemon/bootstrap/ensure-daemon.js";

test("AGE-57 daemon spawn redirects stdout/stderr to an append log fd", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "age57-log-"));
  try {
    const stdio = daemonSpawnStdio(stateRoot);
    assert.deepEqual(stdio.slice(0, 1), ["ignore"]);
    assert.equal(typeof stdio[1], "number");
    assert.equal(stdio[1], stdio[2]);

    const logPath = daemonStderrLogPath(stateRoot);
    const child = spawn(
      process.execPath,
      ["-e", "console.log('age57-log-test'); console.error('age57-err-test');"],
      { stdio },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`child exited ${code}`));
      });
    });

    const log = await readFile(logPath, "utf8");
    assert.match(log, /age57-log-test/);
    assert.match(log, /age57-err-test/);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

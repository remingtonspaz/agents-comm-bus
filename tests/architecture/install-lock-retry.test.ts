import assert from "node:assert/strict";
import { mkdtemp, open as realOpen } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { acquireInstallLock } from "../../core-daemon/host-runtime/install-lock.js";

// AGE-48: acquireInstallLock must retry TRANSIENT win32 open errors
// (EPERM/EBUSY/EACCES — AV/indexer briefly holding a cold freshly-written
// handle), not just EEXIST. All deterministic via injected open/sleep/now/
// platform seams; the fake sleep advances the fake clock so the persistent-error
// case is bounded by timeout instead of looping forever.

async function tempLockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acb-age48-lock-"));
  return path.join(dir, "install.lock");
}

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("AGE-48 acquireInstallLock transient-open retry", () => {
  it("retries a transient win32 EPERM open, then succeeds", async () => {
    const lockPath = await tempLockPath();
    const clock = fakeClock();
    let calls = 0;
    const open = async (p: string, flags: number) => {
      calls += 1;
      if (calls <= 2) throw errno("EPERM");
      return realOpen(p, flags);
    };

    const lock = await acquireInstallLock(lockPath, {
      now: clock.now,
      sleep: clock.sleep,
      platform: "win32",
      open: open as never,
    });

    assert.equal(calls, 3, "open retried twice then succeeded");
    assert.equal(lock.path, lockPath);
    await lock.release();
  });

  it("bounds a persistent transient EPERM by timeout and preserves the real cause", async () => {
    const lockPath = await tempLockPath();
    const clock = fakeClock();
    const open = async () => {
      throw errno("EPERM");
    };

    await assert.rejects(
      () =>
        acquireInstallLock(lockPath, {
          now: clock.now,
          sleep: clock.sleep,
          timeoutMs: 200,
          retryMs: 50,
          platform: "win32",
          open: open as never,
        }),
      (error: Error) => {
        assert.match(error.message, /EPERM/, "surfaces the real errno");
        assert.doesNotMatch(error.message, /is held/, "not mislabeled as lock-held");
        assert.equal((error as { cause?: NodeJS.ErrnoException }).cause?.code, "EPERM", "cause preserved");
        return true;
      },
    );
  });

  it("does NOT retry a non-transient open error (EIO) — fails immediately", async () => {
    const lockPath = await tempLockPath();
    const clock = fakeClock();
    let calls = 0;
    const open = async () => {
      calls += 1;
      throw errno("EIO");
    };

    await assert.rejects(
      () =>
        acquireInstallLock(lockPath, {
          now: clock.now,
          sleep: clock.sleep,
          platform: "win32",
          open: open as never,
        }),
      (error: NodeJS.ErrnoException) => error.code === "EIO",
    );
    assert.equal(calls, 1, "no retry on a non-transient code");
  });

  it("does NOT retry EPERM on POSIX (permanent there) — fails immediately", async () => {
    const lockPath = await tempLockPath();
    const clock = fakeClock();
    let calls = 0;
    const open = async () => {
      calls += 1;
      throw errno("EPERM");
    };

    await assert.rejects(
      () =>
        acquireInstallLock(lockPath, {
          now: clock.now,
          sleep: clock.sleep,
          platform: "linux",
          open: open as never,
        }),
      (error: NodeJS.ErrnoException) => error.code === "EPERM",
    );
    assert.equal(calls, 1, "POSIX EPERM is a real permission failure — no retry");
  });

  it("a write failure after open is fail-fast (no re-open) and closes the handle", async () => {
    const lockPath = await tempLockPath();
    const clock = fakeClock();
    let openCalls = 0;
    let closed = false;
    const open = async () => {
      openCalls += 1;
      return {
        writeFile: async () => {
          throw errno("EIO");
        },
        close: async () => {
          closed = true;
        },
      } as never;
    };

    await assert.rejects(
      () =>
        acquireInstallLock(lockPath, {
          now: clock.now,
          sleep: clock.sleep,
          platform: "win32",
          open: open as never,
        }),
      (error: NodeJS.ErrnoException) => error.code === "EIO",
    );
    assert.equal(openCalls, 1, "no re-open after the lock file was created");
    assert.equal(closed, true, "handle closed on the write failure");
  });
});

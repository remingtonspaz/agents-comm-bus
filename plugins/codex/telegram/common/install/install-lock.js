/**
 * Global central-install lock.
 *
 * Serializes the whole read→reconcile→execute critical section so concurrent
 * installs (e.g. a Claude hook and a Codex hook both firing on first prompt)
 * cannot interleave bundle copies and metadata writes. A SINGLE global lock is
 * deliberate: every install reconciles the shared daemon (bin/daemon.js +
 * version.json), so per-artifact locks would not buy real parallelism — they
 * would only add lock-ordering and deadlock surface.
 *
 * Mirrors the core-daemon spawn-lock idiom (O_CREAT|O_EXCL + token-verified
 * release) and adds bounded wait/retry plus stale-lock stealing, matching the
 * ensureDaemon ergonomics.
 */
import { constants } from "node:fs";
import { open, readFile, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = { timeoutMs: 5_000, retryMs: 50, staleMs: 30_000 };

/**
 * @typedef {Object} InstallLock
 * @property {string} path
 * @property {string} token
 * @property {boolean} stoleStale   true if a stale holder's lock was reclaimed
 * @property {() => Promise<void>} release
 *
 * @typedef {Object} InstallLockOptions
 * @property {number} [timeoutMs]   max time to wait for the lock before throwing
 * @property {number} [retryMs]     poll interval while the lock is held
 * @property {number} [staleMs]     age past which a held lock is considered abandoned
 * @property {() => number} [now]   injectable clock (tests); defaults to Date.now
 * @property {(ms: number) => Promise<void>} [sleep]  injectable delay (tests)
 */

/**
 * Acquire the install lock, waiting (bounded) if another installer holds it.
 *
 * @param {string} lockPath
 * @param {InstallLockOptions} [options]
 * @returns {Promise<InstallLock>}
 */
export async function acquireInstallLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${now()}`;
  const start = now();
  let stoleStale = false;

  for (;;) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.close();
      return {
        path: lockPath,
        token,
        stoleStale,
        release: async () => {
          try {
            const current = await readFile(lockPath, "utf8");
            if (current.trim() === token) {
              await rm(lockPath, { force: true });
            }
          } catch {
            // Best-effort: a later install can treat a leftover lock as stale.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;

      // Held by someone else — reclaim it if it looks abandoned.
      if (await stealIfStale(lockPath, staleMs, now)) {
        stoleStale = true;
        continue;
      }
      if (now() - start >= timeoutMs) {
        throw new Error(`central install lock at ${lockPath} is held; timed out after ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }
}

/**
 * @param {string} lockPath
 * @param {number} staleMs
 * @param {() => number} now
 * @returns {Promise<boolean>}
 */
async function stealIfStale(lockPath, staleMs, now) {
  try {
    const info = await stat(lockPath);
    if (now() - info.mtimeMs > staleMs) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    // Disappeared between the failed open and the stat — the next loop retries.
  }
  return false;
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} error */
function isAlreadyExistsError(error) {
  return typeof error === "object" && error !== null && "code" in error && /** @type {any} */ (error).code === "EEXIST";
}

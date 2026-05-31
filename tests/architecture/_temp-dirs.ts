import { afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pending: string[] = [];

/**
 * Create a temp directory that is removed in `afterEach` (see
 * `registerTempDirCleanup`) rather than inline. Use this for storage-touching
 * tests so the db file is unlinked only after the test callback has returned.
 */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  pending.push(dir);
  return dir;
}

/**
 * Register the temp-dir cleanup hook. Call once at the top level of a
 * storage-touching test file. The runner is launched with --expose-gc.
 *
 * Why this exists: under the tsx ESM loader, node:sqlite frees a db file handle
 * only when its wrapper is garbage-collected, NOT synchronously at close(). On
 * Windows that makes an immediate unlink race to EBUSY/EPERM once several
 * storages are opened in one process (most visible after a migration's second
 * table rebuild). Cleaning up in afterEach — after the test callback has
 * returned — plus an explicit GC releases the handle for tests that don't keep
 * the storage reachable. A handful of tests DO keep it reachable for the whole
 * test (e.g. a live comm adapter on a MessageBus, or a connection left pinned by
 * a constraint-error path); for those the handle simply cannot be freed mid-run
 * under tsx, so after a small bounded retry we swallow ONLY the Windows handle
 * codes (EBUSY/EPERM) and let the OS reclaim the temp dir. Any other error is
 * rethrown. Plain `node` frees the handle at close() and needs none of this;
 * this is purely a tsx + node:sqlite + Windows test-harness artifact (AGE-22).
 */
export function registerTempDirCleanup(): void {
  afterEach(async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === "function") {
      // node:sqlite frees the handle from a finalizer that runs a tick after GC.
      gc();
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    for (const dir of pending.splice(0)) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EBUSY" && code !== "EPERM") throw error;
        // Irreducible tsx + node:sqlite handle-lifetime artifact; OS temp
        // cleanup reclaims the dir. See the doc comment above.
      }
    }
  });
}

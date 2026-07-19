import { constants } from "node:fs";
import { open as fsOpen, readFile, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";
const DEFAULTS = { timeoutMs: 5_000, retryMs: 50, staleMs: 30_000 };
/**
 * AGE-48: transient Windows FS errors on the exclusive-create open. On a cold,
 * freshly-written tree the AV scanner / search indexer briefly holds a handle,
 * so `open(O_CREAT|O_EXCL|O_WRONLY)` can fail with one of these even though no
 * lock is actually held — retry it. Retryable ONLY on win32: on POSIX these are
 * genuine permission failures and must fail fast rather than spin to timeout.
 */
const TRANSIENT_WIN32_OPEN_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
export async function acquireInstallLock(lockPath, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const retryMs = options.retryMs ?? DEFAULTS.retryMs;
    const staleMs = options.staleMs ?? DEFAULTS.staleMs;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const openFn = options.open ?? fsOpen;
    const platform = options.platform ?? process.platform;
    await mkdir(path.dirname(lockPath), { recursive: true });
    const token = `${process.pid}:${now()}`;
    const start = now();
    let stoleStale = false;
    for (;;) {
        // AGE-48: ONLY the exclusive-create open() is inside the retry catch. A
        // holder collision (EEXIST) waits / steals-if-stale as before; a transient
        // win32 FS glitch retries with backoff. The write/close below are
        // deliberately OUTSIDE this catch — retrying after the lock file already
        // exists would leak the open handle and then self-collide on EEXIST.
        let handle;
        try {
            handle = await openFn(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        }
        catch (error) {
            if (isAlreadyExistsError(error)) {
                if (await stealIfStale(lockPath, staleMs, now)) {
                    stoleStale = true;
                    continue;
                }
            }
            else if (!isTransientOpenError(error, platform)) {
                throw error;
            }
            // EEXIST (holder still live) OR a transient win32 open glitch → bounded retry.
            if (now() - start >= timeoutMs) {
                throw lockTimeoutError(lockPath, timeoutMs, error);
            }
            await sleep(retryMs);
            continue;
        }
        // Handle acquired. write/close are fail-fast with best-effort close cleanup.
        try {
            await handle.writeFile(`${token}\n`, "utf8");
            await handle.close();
        }
        catch (error) {
            await handle.close().catch(() => { });
            throw error;
        }
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
                }
                catch {
                    // Best-effort release.
                }
            },
        };
    }
}
async function stealIfStale(lockPath, staleMs, now) {
    try {
        const info = await stat(lockPath);
        if (now() - info.mtimeMs > staleMs) {
            await rm(lockPath, { force: true });
            return true;
        }
    }
    catch {
        // Disappeared between failed open and stat.
    }
    return false;
}
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isAlreadyExistsError(error) {
    return errorCode(error) === "EEXIST";
}
/**
 * AGE-48: a transient exclusive-create open failure that should be retried.
 * Only on win32 (AV/indexer handle contention); POSIX EPERM/EACCES are permanent.
 */
function isTransientOpenError(error, platform) {
    if (platform !== "win32")
        return false;
    const code = errorCode(error);
    return code !== null && TRANSIENT_WIN32_OPEN_CODES.has(code);
}
function errorCode(error) {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = error.code;
        return typeof code === "string" ? code : null;
    }
    return null;
}
/**
 * Preserve the real failure cause: a persistent transient FS error (e.g. EPERM)
 * must NOT be mislabeled "lock held" — that message only fits an EEXIST timeout.
 */
function lockTimeoutError(lockPath, timeoutMs, cause) {
    const code = errorCode(cause);
    if (code !== null && code !== "EEXIST") {
        const error = new Error(`central install lock at ${lockPath}: transient filesystem error ${code} persisted; timed out after ${timeoutMs}ms`);
        error.cause = cause;
        return error;
    }
    return new Error(`central install lock at ${lockPath} is held; timed out after ${timeoutMs}ms`);
}
//# sourceMappingURL=install-lock.js.map
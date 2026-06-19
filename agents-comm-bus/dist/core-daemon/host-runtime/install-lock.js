import { constants } from "node:fs";
import { open, readFile, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";
const DEFAULTS = { timeoutMs: 5_000, retryMs: 50, staleMs: 30_000 };
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
                    }
                    catch {
                        // Best-effort release.
                    }
                },
            };
        }
        catch (error) {
            if (!isAlreadyExistsError(error))
                throw error;
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
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
//# sourceMappingURL=install-lock.js.map
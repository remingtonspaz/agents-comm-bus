import { constants } from "node:fs";
import { open, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_TIMEOUT_MS, DEFAULT_SPAWN_LOCK_STALE_GRACE_MS } from "../config.js";
export function parseSpawnLockToken(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {};
    }
    const parts = trimmed.split(":");
    if (parts.length !== 2) {
        return {};
    }
    const pid = Number(parts[0]);
    const timestamp = Number(parts[1]);
    return {
        pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
        timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined,
    };
}
export function isTokenContentStale(token, options) {
    const { pid, timestamp } = parseSpawnLockToken(token);
    if (pid === undefined || timestamp === undefined) {
        return true;
    }
    if (!options.isPidAlive(pid)) {
        return true;
    }
    return Date.now() - timestamp > options.staleTimeoutMs;
}
export async function isSpawnLockStale(lockPath, options) {
    let raw;
    try {
        raw = await readFile(lockPath, "utf8");
    }
    catch {
        return false;
    }
    return isTokenContentStale(raw.trim(), options);
}
export async function removeSpawnLockIfTokenMatches(lockPath, expectedToken) {
    try {
        const current = await readFile(lockPath, "utf8");
        if (current.trim() !== expectedToken) {
            return false;
        }
        // Narrow residual: read-then-rm is not atomic with another process creating
        // a fresh lock between the two syscalls. Fully closing that would require a
        // rename-based protocol; this compare step prevents the practical stale
        // cleanup race without that complexity.
        await rm(lockPath, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
export async function removeStaleSpawnLock(lockPath, options = {}) {
    const resolved = resolveSpawnLockOptions(options);
    let observedRaw;
    try {
        observedRaw = await readFile(lockPath, "utf8");
    }
    catch {
        return false;
    }
    const observedToken = observedRaw.trim();
    if (!isTokenContentStale(observedToken, resolved)) {
        return false;
    }
    if (options.testHookAfterStaleCheck) {
        await options.testHookAfterStaleCheck();
    }
    return removeSpawnLockIfTokenMatches(lockPath, observedToken);
}
export async function tryAcquireSpawnLock(lockPath, options = {}) {
    await mkdir(path.dirname(lockPath), { recursive: true });
    const acquired = await createSpawnLock(lockPath);
    if (acquired) {
        return acquired;
    }
    if (!(await removeStaleSpawnLock(lockPath, options))) {
        return undefined;
    }
    return createSpawnLock(lockPath);
}
async function createSpawnLock(lockPath) {
    try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        const token = `${process.pid}:${Date.now()}`;
        await handle.writeFile(`${token}\n`, "utf8");
        await handle.close();
        return {
            path: lockPath,
            acquired: true,
            token,
            release: async () => {
                await removeSpawnLockIfTokenMatches(lockPath, token);
            },
        };
    }
    catch (error) {
        if (isAlreadyExistsError(error)) {
            return undefined;
        }
        throw error;
    }
}
function resolveSpawnLockOptions(options) {
    return {
        isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
        staleTimeoutMs: options.staleTimeoutMs ?? defaultSpawnLockStaleTimeoutMs(),
    };
}
export function defaultSpawnLockStaleTimeoutMs(bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS) {
    return bootstrapTimeoutMs + DEFAULT_SPAWN_LOCK_STALE_GRACE_MS;
}
function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function isAlreadyExistsError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
//# sourceMappingURL=spawn-lock.js.map
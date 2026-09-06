import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, link } from "node:fs/promises";
import path from "node:path";
const GUARD_FILE = "owner.lock";
const RECLAIM_FILE = "owner.lock.reclaim";
const RECLAIM2_FILE = "owner.lock.reclaim2";
const RETRY_MS = 20;
const DEFAULT_MAX_WAIT_MS = 2_000;
let loggedDeadReclaim2Paths = new Set();
export function discoveryGuardFile(discoveryRoot) {
    return path.join(discoveryRoot, GUARD_FILE);
}
export function discoveryReclaimLockFile(discoveryRoot) {
    return path.join(discoveryRoot, RECLAIM_FILE);
}
export function discoveryReclaim2LockFile(discoveryRoot) {
    return path.join(discoveryRoot, RECLAIM2_FILE);
}
export function resetDiscoveryGuardTestState() {
    loggedDeadReclaim2Paths = new Set();
}
export function parseDiscoveryGuardToken(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return undefined;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.pid !== "number" ||
            !Number.isInteger(parsed.pid) ||
            parsed.pid <= 0 ||
            typeof parsed.at !== "number" ||
            !Number.isFinite(parsed.at)) {
            return undefined;
        }
        const startedAt = parsed.startedAt === null || parsed.startedAt === undefined
            ? null
            : typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
                ? parsed.startedAt
                : undefined;
        if (startedAt === undefined && parsed.startedAt !== null && parsed.startedAt !== undefined) {
            return undefined;
        }
        const nonce = typeof parsed.nonce === "string" ? parsed.nonce : "";
        return { pid: parsed.pid, startedAt: startedAt ?? null, at: parsed.at, nonce };
    }
    catch {
        return undefined;
    }
}
export function guardTokensEqual(a, b) {
    return (a.pid === b.pid &&
        a.startedAt === b.startedAt &&
        a.at === b.at &&
        a.nonce === b.nonce);
}
export async function withDiscoveryGuard(discoveryRoot, self, fn, options = {}) {
    await mkdir(discoveryRoot, { recursive: true });
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    let acquiredToken;
    while (Date.now() <= deadline) {
        const attempt = await tryAcquireGuard(discoveryRoot, self, isPidAlive, options);
        if (attempt.kind === "acquired") {
            acquiredToken = attempt.token;
            try {
                return { ok: true, value: await fn() };
            }
            finally {
                await releaseGuardIfTokenMatches(discoveryGuardFile(discoveryRoot), acquiredToken);
            }
        }
        if (attempt.kind === "contended") {
            await sleep(RETRY_MS);
            continue;
        }
        return { ok: false, reason: "guard_contended" };
    }
    return { ok: false, reason: "guard_contended" };
}
async function tryAcquireGuard(discoveryRoot, self, isPidAlive, options) {
    const reclaim2Raw = await readGuardRaw(discoveryReclaim2LockFile(discoveryRoot));
    if (reclaim2Raw !== null) {
        const reclaim2 = parseDiscoveryGuardToken(reclaim2Raw);
        if (reclaim2 && !isPidAlive(reclaim2.pid)) {
            logDeadReclaim2Once(discoveryReclaim2LockFile(discoveryRoot));
        }
        return { kind: "failed" };
    }
    const guardPath = discoveryGuardFile(discoveryRoot);
    const token = buildGuardToken(self, options.now);
    const published = await publishFileViaLink(guardPath, token, self.pid, options);
    if (published === "ok") {
        return { kind: "acquired", token };
    }
    const raw = await readGuardRaw(guardPath);
    if (raw === null) {
        return { kind: "contended" };
    }
    const existing = parseDiscoveryGuardToken(raw);
    // G2: unparsable/empty guard tokens are never stolen by age — keep waiting.
    if (!existing) {
        return { kind: "contended" };
    }
    // Own token is always contended while this process may still hold the guard.
    if (existing.pid === self.pid) {
        return { kind: "contended" };
    }
    if (isPidAlive(existing.pid)) {
        return { kind: "contended" };
    }
    await options.beforeReclaim?.();
    const reclaimed = await reclaimDeadGuard(discoveryRoot, self, existing, isPidAlive, options);
    return reclaimed ? { kind: "contended" } : { kind: "failed" };
}
/**
 * Dead-guard recovery runs under owner.lock.reclaim (G3'). Recovery of a dead
 * owner.lock.reclaim token runs only while holding owner.lock.reclaim2 (depth 2).
 * owner.lock.reclaim2 is never auto-reaped: if it exists at all, callers get
 * guard_contended (manual cleanup required — no depth 3).
 */
async function reclaimDeadGuard(discoveryRoot, self, deadToken, isPidAlive, options) {
    const reclaimHeld = await tryAcquireReclaimLock(discoveryRoot, self, isPidAlive, options);
    if (!reclaimHeld)
        return false;
    try {
        await options.beforeQuarantine?.();
        return await quarantineVerifiedGuard(discoveryRoot, self, deadToken, options);
    }
    finally {
        await releaseGuardIfTokenMatches(discoveryReclaimLockFile(discoveryRoot), reclaimHeld);
    }
}
async function tryAcquireReclaimLock(discoveryRoot, self, isPidAlive, options) {
    const reclaimPath = discoveryReclaimLockFile(discoveryRoot);
    const reclaimToken = buildGuardToken({ pid: self.pid, startedAt: self.startedAt }, options.now);
    if (await publishFileViaLink(reclaimPath, reclaimToken, self.pid, options) === "ok") {
        return reclaimToken;
    }
    const raw = await readGuardRaw(reclaimPath);
    if (!raw)
        return undefined;
    const existing = parseDiscoveryGuardToken(raw);
    if (!existing)
        return undefined;
    if (isPidAlive(existing.pid))
        return undefined;
    await options.beforeReclaim2?.();
    const recovered = await recoverDeadReclaimLockUnderReclaim2(discoveryRoot, self, existing, isPidAlive, options);
    if (!recovered)
        return undefined;
    const retryToken = buildGuardToken({ pid: self.pid, startedAt: self.startedAt }, options.now);
    if (await publishFileViaLink(reclaimPath, retryToken, self.pid, options) === "ok") {
        return retryToken;
    }
    return undefined;
}
async function recoverDeadReclaimLockUnderReclaim2(discoveryRoot, self, expectedDeadToken, isPidAlive, options) {
    const reclaim2Path = discoveryReclaim2LockFile(discoveryRoot);
    const reclaim2Raw = await readGuardRaw(reclaim2Path);
    if (reclaim2Raw !== null) {
        const reclaim2 = parseDiscoveryGuardToken(reclaim2Raw);
        if (reclaim2 && !isPidAlive(reclaim2.pid)) {
            logDeadReclaim2Once(reclaim2Path);
        }
        return false;
    }
    const reclaim2Token = buildGuardToken({ pid: self.pid, startedAt: self.startedAt }, options.now);
    if (await publishFileViaLink(reclaim2Path, reclaim2Token, self.pid, options) !== "ok") {
        return false;
    }
    const reclaimPath = discoveryReclaimLockFile(discoveryRoot);
    try {
        const reread = await readGuardRaw(reclaimPath);
        const current = reread ? parseDiscoveryGuardToken(reread) : undefined;
        if (!current || !guardTokensEqual(current, expectedDeadToken)) {
            return false;
        }
        return await quarantineVerifiedGuardFile(reclaimPath, self, expectedDeadToken, options.now);
    }
    finally {
        await releaseGuardIfTokenMatches(reclaim2Path, reclaim2Token);
    }
}
function logDeadReclaim2Once(reclaim2Path) {
    if (loggedDeadReclaim2Paths.has(reclaim2Path))
        return;
    loggedDeadReclaim2Paths.add(reclaim2Path);
    console.error(`dead discovery reclaim2 token at ${reclaim2Path}; manual cleanup required`);
}
async function quarantineVerifiedGuard(discoveryRoot, self, expectedDeadToken, options) {
    return quarantineVerifiedGuardFile(discoveryGuardFile(discoveryRoot), self, expectedDeadToken, options.now);
}
async function quarantineVerifiedGuardFile(guardPath, self, expectedDeadToken, now) {
    const raw = await readGuardRaw(guardPath);
    if (!raw)
        return false;
    const current = parseDiscoveryGuardToken(raw);
    if (!current || !guardTokensEqual(current, expectedDeadToken)) {
        return false;
    }
    const clock = now ?? Date.now;
    const stalePath = `${guardPath}.stale.${self.pid}.${clock()}`;
    try {
        await rename(guardPath, stalePath);
    }
    catch {
        return false;
    }
    await rm(stalePath, { force: true });
    return true;
}
async function publishFileViaLink(targetPath, content, selfPid, options = {}) {
    const clock = options.now ?? Date.now;
    const tempPath = `${targetPath}.tmp.${selfPid}.${clock()}.${randomUUID()}`;
    try {
        await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
        await options.beforeGuardLink?.();
        try {
            await link(tempPath, targetPath);
            return "ok";
        }
        catch (error) {
            if (isAlreadyExistsError(error))
                return "eexist";
            throw error;
        }
    }
    finally {
        await rm(tempPath, { force: true });
    }
}
function buildGuardToken(self, now) {
    const clock = now ?? Date.now;
    const token = {
        pid: self.pid,
        startedAt: self.startedAt,
        at: clock(),
        nonce: randomUUID(),
    };
    return `${JSON.stringify(token)}\n`;
}
async function readGuardRaw(filePath) {
    try {
        return await readFile(filePath, "utf8");
    }
    catch {
        return null;
    }
}
async function releaseGuardIfTokenMatches(guardPath, expectedToken) {
    try {
        const current = await readFile(guardPath, "utf8");
        if (current !== expectedToken)
            return;
        await rm(guardPath, { force: true });
    }
    catch {
        // best-effort release
    }
}
/** Test helper: read the current guard token raw bytes, if any. */
export async function readDiscoveryGuardRaw(discoveryRoot) {
    return readGuardRaw(discoveryGuardFile(discoveryRoot));
}
/** Test helper: read the current reclaim lock raw bytes, if any. */
export async function readDiscoveryReclaimRaw(discoveryRoot) {
    return readGuardRaw(discoveryReclaimLockFile(discoveryRoot));
}
/** Test helper: read the current reclaim2 lock raw bytes, if any. */
export async function readDiscoveryReclaim2Raw(discoveryRoot) {
    return readGuardRaw(discoveryReclaim2LockFile(discoveryRoot));
}
/** Test helper: whether a guard file exists with empty content. */
export async function isDiscoveryGuardEmpty(discoveryRoot) {
    const guardPath = discoveryGuardFile(discoveryRoot);
    try {
        const fileStat = await stat(guardPath);
        if (fileStat.size === 0)
            return true;
        const raw = await readFile(guardPath, "utf8");
        return raw.length === 0;
    }
    catch {
        return false;
    }
}
function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
function isAlreadyExistsError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=discovery-guard.js.map
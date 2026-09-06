import { mkdir, readFile, rename, rm, stat, writeFile, link } from "node:fs/promises";
import path from "node:path";
const GUARD_FILE = "owner.lock";
const RECLAIM_FILE = "owner.lock.reclaim";
const RETRY_MS = 20;
const DEFAULT_MAX_WAIT_MS = 2_000;
export function discoveryGuardFile(discoveryRoot) {
    return path.join(discoveryRoot, GUARD_FILE);
}
export function discoveryReclaimLockFile(discoveryRoot) {
    return path.join(discoveryRoot, RECLAIM_FILE);
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
        return { pid: parsed.pid, startedAt: startedAt ?? null, at: parsed.at };
    }
    catch {
        return undefined;
    }
}
export function guardTokensEqual(a, b) {
    return a.pid === b.pid && a.startedAt === b.startedAt && a.at === b.at;
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
    const guardPath = discoveryGuardFile(discoveryRoot);
    const token = buildGuardToken(self);
    const published = await publishFileViaLink(guardPath, token, self.pid, options.beforeGuardLink);
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
 * Dead-guard recovery runs under owner.lock.reclaim (G3'). A reclaim lock whose pid is
 * dead is recovered once via content-verified rename; a second dead reclaim token yields
 * guard_contended (manual cleanup required — no depth 3).
 */
async function reclaimDeadGuard(discoveryRoot, self, deadToken, isPidAlive, options) {
    const reclaimHeld = await tryAcquireReclaimLock(discoveryRoot, self, isPidAlive);
    if (!reclaimHeld)
        return false;
    try {
        return await quarantineVerifiedGuard(discoveryRoot, self, deadToken, options);
    }
    finally {
        await releaseGuardIfTokenMatches(discoveryReclaimLockFile(discoveryRoot), reclaimHeld);
    }
}
async function tryAcquireReclaimLock(discoveryRoot, self, isPidAlive) {
    const reclaimPath = discoveryReclaimLockFile(discoveryRoot);
    const reclaimToken = buildGuardToken({ pid: self.pid, startedAt: self.startedAt });
    if (await publishFileViaLink(reclaimPath, reclaimToken, self.pid) === "ok") {
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
    if (!(await quarantineVerifiedGuardFile(reclaimPath, self, existing))) {
        console.error("agents-comm-bus: dead discovery reclaim lock could not be recovered; manual cleanup required");
        return undefined;
    }
    if (await publishFileViaLink(reclaimPath, reclaimToken, self.pid) === "ok") {
        return reclaimToken;
    }
    return undefined;
}
async function quarantineVerifiedGuard(discoveryRoot, self, expectedDeadToken, _options) {
    return quarantineVerifiedGuardFile(discoveryGuardFile(discoveryRoot), self, expectedDeadToken);
}
async function quarantineVerifiedGuardFile(guardPath, self, expectedDeadToken) {
    const raw = await readGuardRaw(guardPath);
    if (!raw)
        return false;
    const current = parseDiscoveryGuardToken(raw);
    if (!current || !guardTokensEqual(current, expectedDeadToken)) {
        return false;
    }
    const stalePath = `${guardPath}.stale.${self.pid}.${Date.now()}`;
    try {
        await rename(guardPath, stalePath);
    }
    catch {
        return false;
    }
    await rm(stalePath, { force: true });
    return true;
}
async function publishFileViaLink(targetPath, content, selfPid, beforeLink) {
    const tempPath = `${targetPath}.tmp.${selfPid}.${Date.now()}`;
    await writeFile(tempPath, content, "utf8");
    await beforeLink?.();
    try {
        await link(tempPath, targetPath);
        await rm(tempPath, { force: true });
        return "ok";
    }
    catch (error) {
        await rm(tempPath, { force: true });
        if (isAlreadyExistsError(error))
            return "eexist";
        throw error;
    }
}
function buildGuardToken(self) {
    const token = {
        pid: self.pid,
        startedAt: self.startedAt,
        at: Date.now(),
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
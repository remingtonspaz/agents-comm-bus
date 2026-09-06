import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
/** Bounded, injectable cache. Expired entries are inconclusive, never stale evidence. */
export function createProcessStartIdentityCache(probe, now = Date.now, ttlMs = 1_000, selfPid = process.pid) {
    const values = new Map();
    const pending = new Map();
    let generation = 0;
    const prefetch = async (pids, refresh = false) => {
        const ids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
        const pinned = (pid) => pid === selfPid && values.get(pid)?.value != null;
        const missing = ids.filter(pid => !pending.has(pid) && !pinned(pid) && (refresh ||
            !values.has(pid) || now() - values.get(pid).at >= ttlMs));
        if (missing.length) {
            const epoch = generation;
            // Defer invocation until pending is published, including for synchronous throws.
            const work = Promise.resolve().then(() => probe(missing)).catch(() => new Map())
                .then(results => {
                if (epoch !== generation)
                    return;
                for (const pid of missing)
                    values.set(pid, { value: results.get(pid) ?? null, at: now() });
                // Bound retained entries in long-running daemons.
                for (const pid of values.keys()) {
                    if (values.size <= 4096)
                        break;
                    if (pid !== selfPid)
                        values.delete(pid);
                }
            }).finally(() => {
                if (epoch === generation)
                    for (const pid of missing)
                        pending.delete(pid);
            });
            for (const pid of missing)
                pending.set(pid, work);
        }
        await Promise.all(ids.map(pid => pending.get(pid)));
    };
    return {
        read(pid) {
            if (pending.has(pid))
                return null;
            const entry = values.get(pid);
            if (entry && (pid === selfPid && entry.value != null || now() - entry.at < ttlMs))
                return entry.value;
            void prefetch([pid]);
            return null;
        },
        prefetch,
        reset() { generation += 1; values.clear(); pending.clear(); },
    };
}
function execText(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}
export async function probeProcessIdentities(pids, platform = process.platform, run = execText) {
    const result = new Map();
    pids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
    if (!pids.length)
        return result;
    if (platform === "win32") {
        const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0}:{1}' -f $_.Id,$_.StartTime.ToUniversalTime().Ticks } catch {} }`]);
        for (const line of out.trim().split(/\r?\n/)) {
            const match = /^(\d+):(\d+)$/.exec(line.trim());
            if (match)
                result.set(Number(match[1]), Number(BigInt(match[2]) / 10000n - 62135596800000n));
        }
    }
    else if (platform === "darwin") {
        const out = await run("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]);
        for (const line of out.trim().split(/\r?\n/)) {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (match && Number.isFinite(Date.parse(match[2])))
                result.set(Number(match[1]), Date.parse(match[2]));
        }
    }
    return result;
}
const identityCache = createProcessStartIdentityCache(probeProcessIdentities);
export async function prefetchProcessStartIdentity(pids) {
    if (process.platform === "win32" || process.platform === "darwin") {
        // Sweeps refresh even a warm PID: numbers can be reused between sweeps.
        await identityCache.prefetch(pids, true);
    }
}
export function __resetProcessStartIdentityCacheForTests() { identityCache.reset(); }
/**
 * Stable per-process identity for liveness (stored on session rows).
 * Linux: FNV hash of boot_id + starttime ticks (no Date.now drift).
 * Windows/Darwin: stable epoch ms from OS APIs.
 */
export function readProcessStartIdentity(pid, options = {}) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    try {
        if (options.readProcStat && options.readBootId) {
            return readLinuxProcessStartIdentity(pid, options);
        }
        if (process.platform === "linux") {
            return readLinuxProcessStartIdentity(pid, options);
        }
        if (process.platform === "darwin" || process.platform === "win32") {
            return identityCache.read(pid);
        }
    }
    catch {
        return null;
    }
    return null;
}
/** @deprecated alias — use readProcessStartIdentity */
export function readProcessStartEpochMs(pid, options = {}) {
    return readProcessStartIdentity(pid, options);
}
export function processStartIdentityMatches(stored, pid, options = {}) {
    return compareProcessStartIdentity(stored, pid, options) === "match";
}
/**
 * Compare stored process-start identity to the live pid probe.
 * Inconclusive when either side is unavailable — callers must not treat that as dead.
 */
export function compareProcessStartIdentity(stored, pid, options = {}) {
    if (stored == null)
        return "inconclusive";
    const current = readProcessStartIdentity(pid, options);
    if (current == null)
        return "inconclusive";
    return current === stored ? "match" : "mismatch";
}
function fnv1a32(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
function readLinuxBootId(options) {
    if (options.readBootId)
        return options.readBootId();
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    }
    catch {
        return null;
    }
}
function readLinuxStartTicks(pid, readProcStat) {
    const raw = readProcStat?.(pid) ??
        (() => {
            try {
                return readFileSync(`/proc/${pid}/stat`, "utf8");
            }
            catch {
                return null;
            }
        })();
    if (!raw)
        return null;
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0)
        return null;
    const fields = raw.slice(closeParen + 2).split(" ");
    const startTicks = Number(fields[19]);
    return Number.isFinite(startTicks) ? startTicks : null;
}
function readLinuxProcessStartIdentity(pid, options) {
    const bootId = readLinuxBootId(options);
    const startTicks = readLinuxStartTicks(pid, options.readProcStat);
    if (!bootId || startTicks == null)
        return null;
    return fnv1a32(`${bootId}:${startTicks}`);
}
/** Boot epoch for the current process — stable for this process lifetime. */
let currentProcessStart;
export function currentProcessStartEpochMs() {
    if (currentProcessStart !== undefined)
        return currentProcessStart;
    const fromOs = readProcessStartIdentity(process.pid);
    currentProcessStart = fromOs ?? Date.now() - Math.round(process.uptime() * 1000);
    return currentProcessStart;
}
//# sourceMappingURL=process-start-epoch.js.map
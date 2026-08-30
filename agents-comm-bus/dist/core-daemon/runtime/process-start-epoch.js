import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
/**
 * Best-effort process creation epoch (ms). Used for AGE-101 pid+start-time
 * liveness; returns null when the platform cannot resolve the stamp.
 */
export function readProcessStartEpochMs(pid, options = {}) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    try {
        if (process.platform === "linux") {
            return readLinuxProcessStartEpochMs(pid, options.readProcStat);
        }
        if (process.platform === "darwin") {
            return readDarwinProcessStartEpochMs(pid);
        }
        if (process.platform === "win32") {
            return readWindowsProcessStartEpochMs(pid);
        }
    }
    catch {
        return null;
    }
    return null;
}
function readLinuxProcessStartEpochMs(pid, readProcStat) {
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
    if (!Number.isFinite(startTicks))
        return null;
    const uptimeRaw = readFileSync("/proc/uptime", "utf8").split(/\s+/)[0];
    const uptimeSec = Number(uptimeRaw);
    if (!Number.isFinite(uptimeSec))
        return null;
    const bootMs = Date.now() - uptimeSec * 1000;
    const hz = 100;
    return bootMs + (startTicks / hz) * 1000;
}
function readDarwinProcessStartEpochMs(pid) {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
    }).trim();
    if (!out)
        return null;
    const parsed = Date.parse(out);
    return Number.isFinite(parsed) ? parsed : null;
}
function readWindowsProcessStartEpochMs(pid) {
    const out = execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: "utf8" }).trim();
    const ticks = Number(out);
    if (!Number.isFinite(ticks))
        return null;
    return ticks / 10_000 - 62_135_596_800_000;
}
/** Boot epoch for the current process — stable for this process lifetime. */
export function currentProcessStartEpochMs() {
    const fromOs = readProcessStartEpochMs(process.pid);
    if (fromOs != null)
        return fromOs;
    // Fallback when OS lookup fails: monotonic anchor tied to this pid's lifetime.
    return Date.now() - Math.round(process.uptime() * 1000);
}
//# sourceMappingURL=process-start-epoch.js.map
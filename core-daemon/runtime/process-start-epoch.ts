import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessStartIdentityOptions {
  readProcStat?: (pid: number) => string | null;
  readBootId?: () => string | null;
  readProcUptime?: () => string | null;
  readClockTicksPerSec?: () => number | null;
}

/**
 * Stable per-process identity for liveness (stored on session rows).
 * Linux: FNV hash of boot_id + starttime ticks (no Date.now drift).
 * Windows/Darwin: stable epoch ms from OS APIs.
 */
export function readProcessStartIdentity(
  pid: number,
  options: ProcessStartIdentityOptions = {},
): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (options.readProcStat && options.readBootId) {
      return readLinuxProcessStartIdentity(pid, options);
    }
    if (process.platform === "linux") {
      return readLinuxProcessStartIdentity(pid, options);
    }
    if (process.platform === "darwin") {
      return readDarwinProcessStartEpochMs(pid);
    }
    if (process.platform === "win32") {
      return readWindowsProcessStartEpochMs(pid);
    }
  } catch {
    return null;
  }
  return null;
}

/** @deprecated alias — use readProcessStartIdentity */
export function readProcessStartEpochMs(
  pid: number,
  options: ProcessStartIdentityOptions = {},
): number | null {
  return readProcessStartIdentity(pid, options);
}

export function processStartIdentityMatches(
  stored: number,
  pid: number,
  options: ProcessStartIdentityOptions = {},
): boolean {
  return compareProcessStartIdentity(stored, pid, options) === "match";
}

/** Definite mismatch vs inconclusive (probe unavailable / no stored identity). */
export type ProcessStartIdentityCompare = "match" | "mismatch" | "inconclusive";

/**
 * Compare stored process-start identity to the live pid probe.
 * Inconclusive when either side is unavailable — callers must not treat that as dead.
 */
export function compareProcessStartIdentity(
  stored: number | null | undefined,
  pid: number,
  options: ProcessStartIdentityOptions = {},
): ProcessStartIdentityCompare {
  if (stored == null) return "inconclusive";
  const current = readProcessStartIdentity(pid, options);
  if (current == null) return "inconclusive";
  return current === stored ? "match" : "mismatch";
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function readLinuxBootId(options: ProcessStartIdentityOptions): string | null {
  if (options.readBootId) return options.readBootId();
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

function readLinuxStartTicks(
  pid: number,
  readProcStat?: (pid: number) => string | null,
): number | null {
  const raw =
    readProcStat?.(pid) ??
    (() => {
      try {
        return readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return null;
      }
    })();
  if (!raw) return null;
  const closeParen = raw.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = raw.slice(closeParen + 2).split(" ");
  const startTicks = Number(fields[19]);
  return Number.isFinite(startTicks) ? startTicks : null;
}

function readLinuxProcessStartIdentity(
  pid: number,
  options: ProcessStartIdentityOptions,
): number | null {
  const bootId = readLinuxBootId(options);
  const startTicks = readLinuxStartTicks(pid, options.readProcStat);
  if (!bootId || startTicks == null) return null;
  return fnv1a32(`${bootId}:${startTicks}`);
}

function readDarwinProcessStartEpochMs(pid: number): number | null {
  const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  if (!out) return null;
  const parsed = Date.parse(out);
  return Number.isFinite(parsed) ? parsed : null;
}

function readWindowsProcessStartEpochMs(pid: number): number | null {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: "utf8" },
  ).trim();
  const ticks = Number(out);
  if (!Number.isFinite(ticks)) return null;
  return ticks / 10_000 - 62_135_596_800_000;
}

/** Boot epoch for the current process — stable for this process lifetime. */
export function currentProcessStartEpochMs(): number {
  const fromOs = readProcessStartIdentity(process.pid);
  if (fromOs != null) return fromOs;
  return Date.now() - Math.round(process.uptime() * 1000);
}

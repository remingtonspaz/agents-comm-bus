import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessStartIdentityOptions {
  readProcStat?: (pid: number) => string | null;
  readBootId?: () => string | null;
  readProcUptime?: () => string | null;
  readClockTicksPerSec?: () => number | null;
}

/** Bounded, injectable cache. Expired entries are inconclusive, never stale evidence. */
export function createProcessStartIdentityCache(
  probe: (pids: number[]) => Promise<ReadonlyMap<number, number | null>>,
  now: () => number = Date.now,
  ttlMs = 1_000,
) {
  const values = new Map<number, { value: number | null; at: number }>();
  const pending = new Map<number, Promise<void>>();
  let generation = 0;
  const prefetch = async (pids: readonly number[], refresh = false): Promise<void> => {
    const ids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
    const missing = ids.filter(pid => !pending.has(pid) && (refresh ||
      !values.has(pid) || now() - values.get(pid)!.at >= ttlMs));
    if (missing.length) {
      const epoch = generation;
      // Defer invocation until pending is published, including for synchronous throws.
      const work = Promise.resolve().then(() => probe(missing)).catch(() => new Map<number, number | null>())
        .then(results => {
          if (epoch !== generation) return;
          for (const pid of missing) values.set(pid, { value: results.get(pid) ?? null, at: now() });
          // Bound retained entries in long-running daemons.
          while (values.size > 4096) values.delete(values.keys().next().value!);
        }).finally(() => {
          if (epoch === generation) for (const pid of missing) pending.delete(pid);
        });
      for (const pid of missing) pending.set(pid, work);
    }
    await Promise.all(ids.map(pid => pending.get(pid)));
  };
  return {
    read(pid: number): number | null {
      if (pending.has(pid)) return null;
      const entry = values.get(pid);
      if (entry && now() - entry.at < ttlMs) return entry.value;
      void prefetch([pid]);
      return null;
    },
    prefetch,
    reset() { generation += 1; values.clear(); pending.clear(); },
  };
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", windowsHide: true, timeout: 2_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export async function probeProcessIdentities(
  pids: number[],
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => Promise<string> = execText,
): Promise<Map<number, number | null>> {
  const result = new Map<number, number | null>();
  pids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
  if (!pids.length) return result;
  if (platform === "win32") {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0}:{1}' -f $_.Id,$_.StartTime.ToUniversalTime().Ticks } catch {} }`]);
    for (const line of out.trim().split(/\r?\n/)) {
      const match = /^(\d+):(\d+)$/.exec(line.trim());
      if (match) result.set(Number(match[1]), Number(match[2]) / 10_000 - 62_135_596_800_000);
    }
  } else if (platform === "darwin") {
    const out = await run("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]);
    for (const line of out.trim().split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match && Number.isFinite(Date.parse(match[2]))) result.set(Number(match[1]), Date.parse(match[2]));
    }
  }
  return result;
}

const identityCache = createProcessStartIdentityCache(probeProcessIdentities);

export async function prefetchProcessStartIdentity(pids: readonly number[]): Promise<void> {
  if (process.platform === "win32" || process.platform === "darwin") {
    // Sweeps refresh even a warm PID: numbers can be reused between sweeps.
    await identityCache.prefetch(pids, true);
  }
}

export function __resetProcessStartIdentityCacheForTests(): void { identityCache.reset(); }

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
    if (process.platform === "darwin" || process.platform === "win32") {
      return identityCache.read(pid);
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

/** Boot epoch for the current process — stable for this process lifetime. */
export function currentProcessStartEpochMs(): number {
  const fromOs = readProcessStartIdentity(process.pid);
  if (fromOs != null) return fromOs;
  return Date.now() - Math.round(process.uptime() * 1000);
}

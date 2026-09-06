import { readFile } from "node:fs/promises";

import type { AuditStore } from "agents-comm-bus-core";
import {
  discoveryClaimIdentityMatches,
  readDiscoveryClaim,
  writeDaemonDiscoveryFiles,
} from "./discovery-claim.js";
import { currentProcessStartEpochMs } from "../runtime/process-start-epoch.js";

export type DaemonPidWatchdogResult =
  | { status: "current"; selfPid: number }
  | { status: "superseded"; selfPid: number; ownerPid: number }
  | { status: "reclaimed"; selfPid: number; reason: "missing" | "dead_owner"; ownerPid?: number }
  | { status: "stayed_alive"; selfPid: number; reason: "invalid_pid" | "read_error" | "liveness_error" | "reclaim_error"; ownerPid?: number; error?: string };

export type PidFileRead =
  | { status: "pid"; pid: number }
  | { status: "missing" }
  | { status: "invalid"; raw: string }
  | { status: "error"; error: unknown };

export interface DaemonPidWatchdogCheckOptions {
  stateRoot?: string;
  discoveryRoot?: string;
  pidFile: string;
  port: number;
  selfPid?: number;
  selfStartedAt?: number | null;
  readPidFile?: (pidFile: string) => Promise<PidFileRead>;
  isPidAlive?: (pid: number) => boolean;
  writeDiscoveryFiles?: typeof writeDaemonDiscoveryFiles;
}

export interface DaemonPidWatchdogTickOptions extends DaemonPidWatchdogCheckOptions {
  audit?: AuditStore;
  stopDaemon?: () => Promise<void> | void;
  exitProcess?: (code: number) => void;
}

export interface StartDaemonPidWatchdogOptions extends DaemonPidWatchdogTickOptions {
  intervalMs?: number;
  initialDelayMs?: number;
}

export interface DaemonPidWatchdogHandle {
  stop(): void;
}

export function startDaemonPidWatchdog(
  options: StartDaemonPidWatchdogOptions,
): DaemonPidWatchdogHandle {
  const intervalMs = options.intervalMs ?? 30_000;
  const initialDelayMs = options.initialDelayMs ?? 5_000;
  let stopped = false;
  let running = false;
  let interval: NodeJS.Timeout | undefined;

  const run = (): void => {
    if (stopped || running) return;
    running = true;
    void runDaemonPidWatchdogTick(options)
      .catch((error) => {
        console.error(
          `agents-comm-bus: daemon pid watchdog failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const timeout = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
  }, initialDelayMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    },
  };
}

export async function runDaemonPidWatchdogTick(
  options: DaemonPidWatchdogTickOptions,
): Promise<DaemonPidWatchdogResult> {
  const result = await checkDaemonPidOwnership(options);

  if (result.status === "superseded") {
    await appendAudit(options.audit, {
      kind: "daemon_superseded",
      detail: {
        self_pid: result.selfPid,
        canonical_pid: result.ownerPid,
      },
    });
    await options.stopDaemon?.();
    (options.exitProcess ?? ((code: number) => process.exit(code)))(0);
    return result;
  }

  if (result.status === "reclaimed") {
    await appendAudit(options.audit, {
      kind: "daemon_discovery_reclaimed",
      detail: {
        self_pid: result.selfPid,
        reason: result.reason,
        previous_pid: result.ownerPid,
      },
    });
  } else if (result.status === "stayed_alive") {
    await appendAudit(options.audit, {
      kind: "daemon_pid_watchdog_error",
      detail: {
        self_pid: result.selfPid,
        reason: result.reason,
        owner_pid: result.ownerPid,
        error: result.error,
      },
    });
  }

  return result;
}

export async function checkDaemonPidOwnership(
  options: DaemonPidWatchdogCheckOptions,
): Promise<DaemonPidWatchdogResult> {
  const selfPid = options.selfPid ?? process.pid;
  const selfStartedAt = options.selfStartedAt ?? currentProcessStartEpochMs();
  const read = options.readPidFile ?? readPidFile;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const writeDiscovery = options.writeDiscoveryFiles ?? writeDaemonDiscoveryFiles;
  const discoveryRoot = options.discoveryRoot ?? options.stateRoot;

  if (discoveryRoot) {
    const owner = await readDiscoveryClaim(discoveryRoot);
    if (owner) {
      if (discoveryClaimIdentityMatches(owner, selfPid, selfStartedAt)) {
        return { status: "current", selfPid };
      }

      let ownerAlive: boolean;
      try {
        ownerAlive = isPidAlive(owner.pid);
      } catch (error) {
        return {
          status: "stayed_alive",
          selfPid,
          reason: "liveness_error",
          ownerPid: owner.pid,
          error: errorMessage(error),
        };
      }

      if (ownerAlive && owner.pid !== selfPid) {
        return { status: "superseded", selfPid, ownerPid: owner.pid };
      }

      if (!ownerAlive) {
        return await reclaimDiscovery(options, selfPid, writeDiscovery, owner.pid);
      }

      return { status: "superseded", selfPid, ownerPid: owner.pid };
    }
  }

  const pidFile = await read(options.pidFile);
  if (pidFile.status === "missing") {
    return await reclaimDiscovery(options, selfPid, writeDiscovery);
  }

  if (pidFile.status === "invalid") {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "invalid_pid",
      error: `invalid pid file content: ${JSON.stringify(pidFile.raw)}`,
    };
  }

  if (pidFile.status === "error") {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "read_error",
      error: errorMessage(pidFile.error),
    };
  }

  if (pidFile.pid === selfPid) {
    return { status: "current", selfPid };
  }

  let ownerAlive: boolean;
  try {
    ownerAlive = isPidAlive(pidFile.pid);
  } catch (error) {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "liveness_error",
      ownerPid: pidFile.pid,
      error: errorMessage(error),
    };
  }

  if (ownerAlive) {
    return { status: "superseded", selfPid, ownerPid: pidFile.pid };
  }

  return await reclaimDiscovery(options, selfPid, writeDiscovery, pidFile.pid);
}

async function reclaimDiscovery(
  options: DaemonPidWatchdogCheckOptions,
  selfPid: number,
  writeDiscovery: typeof writeDaemonDiscoveryFiles,
  previousPid?: number,
): Promise<DaemonPidWatchdogResult> {
  if (!options.stateRoot) {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "reclaim_error",
      ownerPid: previousPid,
      error: "stateRoot is required to reclaim discovery",
    };
  }

  try {
    await writeDiscovery({
      stateRoot: options.stateRoot ?? "",
      discoveryRoot: options.discoveryRoot,
      pid: selfPid,
      port: options.port,
      startedAt: options.selfStartedAt,
    });
    return {
      status: "reclaimed",
      selfPid,
      reason: previousPid === undefined ? "missing" : "dead_owner",
      ...(previousPid === undefined ? {} : { ownerPid: previousPid }),
    };
  } catch (error) {
    return {
      status: "stayed_alive",
      selfPid,
      reason: "reclaim_error",
      ownerPid: previousPid,
      error: errorMessage(error),
    };
  }
}

async function readPidFile(pidFile: string): Promise<PidFileRead> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) return { status: "pid", pid };
    return { status: "invalid", raw };
  } catch (error) {
    if (isFileNotFound(error)) return { status: "missing" };
    return { status: "error", error };
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function appendAudit(
  audit: AuditStore | undefined,
  event: { kind: "daemon_superseded" | "daemon_discovery_reclaimed" | "daemon_pid_watchdog_error"; detail: Record<string, unknown> },
): Promise<void> {
  if (!audit) return;
  await audit.append({ timestamp: Date.now(), ...event });
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

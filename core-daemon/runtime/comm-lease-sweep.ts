import { constants, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccountRegistration, CommId, Storage } from "agents-comm-bus-core";

import { DAEMON_NAME } from "../config.js";
import type { JsonlAuditStore } from "../storage/audit.js";
import type { EnsureRegistrationContext } from "./ensure-registration.js";
import { ensureRegistrationForAccount } from "./ensure-registration.js";
import {
  commLeasePath,
  nudgeLeaseReacquire,
  type LeaseRecord,
} from "./comm-lease.js";
import {
  compareProcessStartIdentity,
  type ProcessStartIdentityOptions,
} from "./process-start-epoch.js";
import { defaultIsPidAlive, type SessionOwnerLiveness } from "./session-owner-liveness.js";
import { buildGlobalDesiredRegistrationIds } from "./scope-release-reconcile.js";
import type { CommAdapterFactory } from "./comm-factory.js";

/** Default periodic comm-lease sweep interval. */
export const DEFAULT_COMM_LEASE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface CommLeaseSweepCounts {
  examined: number;
  retained: number;
  reaped: number;
  cas_lost: number;
  guard_contended: number;
  malformed: number;
  recovered: number;
}

export type CommLeaseOwnerState = "definitely_dead" | "retain";

export interface CommLeaseOwnerLivenessOptions extends ProcessStartIdentityOptions {
  isPidAlive?: (pid: number) => boolean;
  readProcessStartEpochMs?: (pid: number) => number | null;
}

/**
 * AGE-102: classify an on-disk comm lease owner. Never treats renewedAt age alone
 * as dead — only absent pid or a definite process-start mismatch.
 */
export function classifyCommLeaseOwner(
  record: Pick<LeaseRecord, "pid" | "process_start_time">,
  options: CommLeaseOwnerLivenessOptions = {},
): CommLeaseOwnerState {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!Number.isInteger(record.pid) || record.pid <= 0 || !isPidAlive(record.pid)) {
    return "definitely_dead";
  }

  if (record.process_start_time != null) {
    const compare = options.readProcessStartEpochMs
      ? (() => {
          const current = options.readProcessStartEpochMs!(record.pid);
          if (current == null) return "inconclusive" as const;
          return current === record.process_start_time ? "match" : "mismatch";
        })()
      : compareProcessStartIdentity(record.process_start_time, record.pid, options);
    if (compare === "mismatch") return "definitely_dead";
  }

  return "retain";
}

export function commLeaseLockRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, `.${DAEMON_NAME}`, "comm-locks");
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function parseLeaseRecord(raw: string): LeaseRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.comm_id !== "string") return null;
    if (typeof parsed.resource_id !== "string") return null;
    return parsed as LeaseRecord;
  } catch {
    return null;
  }
}

async function acquireSweepGuard(
  leasePath: string,
  selfPid: number,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  stalenessMs: number,
): Promise<string | null> {
  const guardPath = `${leasePath}.guard`;
  await mkdir(path.dirname(guardPath), { recursive: true });
  const token = `${selfPid}:${now()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.close();
      return token;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (attempt === 0 && (await guardIsStale(guardPath, selfPid, now, isPidAlive, stalenessMs))) {
        await rm(guardPath, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

async function guardIsStale(
  guardPath: string,
  selfPid: number,
  now: () => number,
  isPidAlive: (pid: number) => boolean,
  stalenessMs: number,
): Promise<boolean> {
  try {
    const raw = (await readFile(guardPath, "utf8")).trim();
    const pid = Number(raw.split(":")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    if (pid === selfPid) return true;
    return !isPidAlive(pid);
  } catch {
    try {
      const info = await stat(guardPath);
      return now() - info.mtimeMs > stalenessMs;
    } catch {
      return false;
    }
  }
}

async function releaseSweepGuard(leasePath: string, token: string): Promise<void> {
  const guardPath = `${leasePath}.guard`;
  try {
    const current = (await readFile(guardPath, "utf8")).trim();
    if (current === token) {
      await rm(guardPath, { force: true });
    }
  } catch {
    // best-effort
  }
}

export interface CommLeaseSweepRecoveryInput {
  storage: Storage;
  ensure: EnsureRegistrationContext;
  audit?: JsonlAuditStore;
  discoveryRoot?: string;
  sessionOwnerIsLive?: SessionOwnerLiveness;
  factories?: readonly CommAdapterFactory[];
}

export function isCommLeaseRecoveryAllowed(recoveryAllowed?: () => boolean): boolean {
  return recoveryAllowed?.() ?? true;
}

async function recoverAfterLeaseDeletion(
  comm_id: string,
  resource_id: string,
  input: CommLeaseSweepRecoveryInput,
): Promise<boolean> {
  if (nudgeLeaseReacquire(comm_id, resource_id)) {
    return true;
  }

  const registrations = await input.storage.listAccountRegistrations({
    comm: comm_id as CommId,
  });
  const registration = registrations.find((row) => row.bot_user_id === resource_id);
  if (!registration || !(await isRegistrationDesiredForRecovery(registration, input))) {
    return false;
  }

  await ensureRegistrationForAccount(registration, input.ensure);
  return true;
}

async function isRegistrationDesiredForRecovery(
  registration: AccountRegistration,
  input: CommLeaseSweepRecoveryInput,
): Promise<boolean> {
  if (registration.activation === "eager") return true;
  if (!input.discoveryRoot || !input.sessionOwnerIsLive || !input.factories?.length) {
    return false;
  }
  const desired = await buildGlobalDesiredRegistrationIds({
    storage: input.storage,
    factories: [...input.factories],
    discoveryRoot: input.discoveryRoot,
    sessionOwnerIsLive: input.sessionOwnerIsLive,
  });
  return desired.has(registration.registration_id);
}

export async function runCommLeaseSweep(input: {
  homeDir?: string;
  selfPid?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  ownerLivenessOptions?: CommLeaseOwnerLivenessOptions;
  stalenessMs?: number;
  log?: (message: string) => void;
  audit?: JsonlAuditStore;
  recovery?: CommLeaseSweepRecoveryInput;
  /** Test hook: hold the sweep in-flight until released. */
  sweepHold?: () => Promise<void>;
  /** Test hook: invoked after guard acquire, before guarded re-read. */
  afterGuardAcquired?: (leasePath: string, snapshot: string) => void | Promise<void>;
  /** Test hook: invoked after guard release, before recovery. */
  beforeRecovery?: (leasePath: string) => void | Promise<void>;
  /** When false, post-delete nudge/ensure is skipped (scheduler stop / daemon retirement). */
  recoveryAllowed?: () => boolean;
}): Promise<CommLeaseSweepCounts> {
  const counts: CommLeaseSweepCounts = {
    examined: 0,
    retained: 0,
    reaped: 0,
    cas_lost: 0,
    guard_contended: 0,
    malformed: 0,
    recovered: 0,
  };
  const homeDir = input.homeDir ?? os.homedir();
  const selfPid = input.selfPid ?? process.pid;
  const now = input.now ?? Date.now;
  const isPidAlive = input.isPidAlive ?? input.ownerLivenessOptions?.isPidAlive ?? defaultIsPidAlive;
  const livenessOptions: CommLeaseOwnerLivenessOptions = {
    ...input.ownerLivenessOptions,
    isPidAlive,
  };
  const stalenessMs = input.stalenessMs ?? 90_000;
  const root = commLeaseLockRoot(homeDir);

  if (!existsSync(root)) {
    return counts;
  }

  let commDirs: string[];
  try {
    commDirs = await readdir(root);
  } catch (error) {
    throw new Error(
      `comm lease sweep: unreadable lock root ${root}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const commId of commDirs) {
    const commDir = path.join(root, commId);
    let entries: string[];
    try {
      const info = await stat(commDir);
      if (!info.isDirectory()) continue;
      entries = await readdir(commDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".json.guard")) continue;
      if (entry.endsWith(".guard")) continue;

      const leasePath = path.join(commDir, entry);
      counts.examined += 1;

      let snapshot: string;
      try {
        snapshot = await readFile(leasePath, "utf8");
      } catch {
        counts.malformed += 1;
        continue;
      }

      const record = parseLeaseRecord(snapshot);
      if (!record) {
        counts.malformed += 1;
        continue;
      }

      if (classifyCommLeaseOwner(record, livenessOptions) !== "definitely_dead") {
        counts.retained += 1;
        continue;
      }

      const guard = await acquireSweepGuard(leasePath, selfPid, now, isPidAlive, stalenessMs);
      if (!guard) {
        counts.guard_contended += 1;
        continue;
      }

      let reaped: { comm_id: string; resource_id: string } | null = null;
      try {
        if (input.afterGuardAcquired) {
          await input.afterGuardAcquired(leasePath, snapshot);
        }

        let reread: string;
        try {
          reread = await readFile(leasePath, "utf8");
        } catch {
          counts.cas_lost += 1;
          continue;
        }

        if (reread !== snapshot) {
          counts.cas_lost += 1;
          continue;
        }

        const current = parseLeaseRecord(reread);
        if (!current || classifyCommLeaseOwner(current, livenessOptions) !== "definitely_dead") {
          counts.cas_lost += 1;
          continue;
        }

        await rm(leasePath, { force: true });
        counts.reaped += 1;

        await input.audit
          ?.append({
            timestamp: now(),
            kind: "comm_lease_reaped",
            detail: {
              comm_id: current.comm_id,
              resource_id: current.resource_id,
              holder_pid: current.pid,
              holder_rank: current.authorityRank,
              process_start_time: current.process_start_time ?? null,
            },
          })
          .catch(() => {});

        reaped = {
          comm_id: current.comm_id,
          resource_id: current.resource_id,
        };
      } finally {
        await releaseSweepGuard(leasePath, guard);
      }

      if (reaped && input.recovery) {
        if (input.beforeRecovery) {
          await input.beforeRecovery(leasePath);
        }
        if (!isCommLeaseRecoveryAllowed(input.recoveryAllowed)) {
          continue;
        }
        const recovered = await recoverAfterLeaseDeletion(
          reaped.comm_id,
          reaped.resource_id,
          input.recovery,
        ).catch(() => false);
        if (recovered) counts.recovered += 1;
      }
    }
  }

  if (input.sweepHold) {
    await input.sweepHold();
  }

  const log = input.log ?? (() => {});
  log(
    `agents-comm-bus: comm lease sweep: examined=${counts.examined} ` +
      `retained=${counts.retained} reaped=${counts.reaped} cas_lost=${counts.cas_lost} ` +
      `guard_contended=${counts.guard_contended} malformed=${counts.malformed} ` +
      `recovered=${counts.recovered}`,
  );

  return counts;
}

export interface CommLeaseSweepHandle {
  stop(): void;
}

export function startCommLeaseSweep(options: {
  homeDir?: string;
  selfPid?: number;
  intervalMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  ownerLivenessOptions?: CommLeaseOwnerLivenessOptions;
  stalenessMs?: number;
  log?: (message: string) => void;
  audit?: JsonlAuditStore;
  recovery?: CommLeaseSweepRecoveryInput;
  sweepHold?: () => Promise<void>;
  afterGuardAcquired?: (leasePath: string, snapshot: string) => void | Promise<void>;
  beforeRecovery?: (leasePath: string) => void | Promise<void>;
  recoveryAllowed?: () => boolean;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Run one sweep immediately on start (daemon boot one-shot). */
  runOnStart?: boolean;
}): CommLeaseSweepHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_COMM_LEASE_SWEEP_INTERVAL_MS;
  const setIntervalFn =
    options.setIntervalFn ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearIntervalFn =
    options.clearIntervalFn ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));

  let sweepInFlight = false;
  let pendingTick = false;
  let stopped = false;
  let interval: unknown = null;

  const tick = (): void => {
    if (stopped) return;
    if (sweepInFlight) {
      pendingTick = true;
      return;
    }
    sweepInFlight = true;
    void runCommLeaseSweep({
      homeDir: options.homeDir,
      selfPid: options.selfPid,
      now: options.now,
      isPidAlive: options.isPidAlive,
      ownerLivenessOptions: options.ownerLivenessOptions,
      stalenessMs: options.stalenessMs,
      log: options.log,
      audit: options.audit,
      recovery: options.recovery,
      sweepHold: options.sweepHold,
      afterGuardAcquired: options.afterGuardAcquired,
      beforeRecovery: options.beforeRecovery,
      recoveryAllowed: options.recoveryAllowed ?? (() => !stopped),
    })
      .catch(async (error) => {
        const log = options.log ?? console.error;
        const reason = error instanceof Error ? error.message : String(error);
        log(`agents-comm-bus: comm lease sweep failed: ${reason}`);
        await options.audit
          ?.append({
            timestamp: (options.now ?? Date.now)(),
            kind: "comm_lease_sweep_failed",
            detail: { phase: "periodic", reason },
          })
          .catch(() => {});
      })
      .finally(() => {
        sweepInFlight = false;
        if (!stopped && pendingTick) {
          pendingTick = false;
          tick();
        }
      });
  };

  if (options.runOnStart !== false) {
    tick();
  }

  interval = setIntervalFn(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (interval != null) clearIntervalFn(interval);
      interval = null;
    },
  };
}

/** Resolve comm/resource ids from a lease path under the fixed comm-lock root. */
export function commLeaseIdsFromPath(
  leasePath: string,
  homeDir: string = os.homedir(),
): { comm_id: string; resource_id: string } | null {
  const root = commLeaseLockRoot(homeDir);
  const rel = path.relative(root, leasePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || !parts[1].endsWith(".json")) return null;
  return {
    comm_id: parts[0],
    resource_id: parts[1].slice(0, -".json".length),
  };
}

export { commLeasePath };

/**
 * AGE-102: ordered daemon bootstrap — boot sweep, optional periodic start,
 * then boot restore and eager reconcile. Periodic starts only after a
 * successful boot sweep; restore/eager always run fail-safe.
 */
export async function runCommLeaseDaemonBootstrap(input: {
  bootSweep: () => Promise<void>;
  startPeriodicSweep: () => CommLeaseSweepHandle;
  bootRestore: () => Promise<void>;
  eagerReconcile: () => Promise<void>;
  onBootSweepFailed: (error: unknown) => Promise<void>;
}): Promise<CommLeaseSweepHandle | null> {
  let periodic: CommLeaseSweepHandle | null = null;
  try {
    await input.bootSweep();
    periodic = input.startPeriodicSweep();
  } catch (error) {
    await input.onBootSweepFailed(error);
  }
  await input.bootRestore();
  await input.eagerReconcile();
  return periodic;
}

/**
 * AGE-102: retirement-safe publication of the periodic sweep handle returned
 * from async bootstrap. Late handles are stopped immediately and not retained.
 */
export function publishCommLeaseSweepHandle(input: {
  retiring: boolean;
  current: CommLeaseSweepHandle | null;
  incoming: CommLeaseSweepHandle | null;
}): { current: CommLeaseSweepHandle | null; stoppedIncoming: boolean } {
  if (input.retiring) {
    input.incoming?.stop();
    return { current: input.current, stoppedIncoming: input.incoming != null };
  }
  return { current: input.incoming, stoppedIncoming: false };
}

import type { Session, SessionEndObservation, Storage } from "agents-comm-bus-core";

import {
  classifySessionOwnerProcess,
  type SessionOwnerLivenessOptions,
} from "./session-owner-liveness.js";
import type {
  ScopeReleaseReconcileCounts,
  ScopeReleaseReconcileState,
} from "./scope-release-reconcile.js";
import { reconcileLazyAdapterScopes } from "./scope-release-reconcile.js";

/** Default periodic sweep interval — boot-only is insufficient for long-lived daemons. */
export const DEFAULT_SESSION_END_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionEndSweepCounts {
  ended: number;
  kept_live: number;
  kept_stale: number;
  kept_no_owner_leased: number;
  cas_lost: number;
  reconcile?: ScopeReleaseReconcileCounts;
}

export type SessionScopeReconcileInput = Parameters<typeof reconcileLazyAdapterScopes>[0];

export function sessionEndObservation(session: Session): SessionEndObservation {
  return {
    status: session.status,
    lease_holder_connection_id: session.lease_holder_connection_id,
    lease_owner_process_pid: session.lease_owner_process_pid,
    lease_owner_process_registered_at: session.lease_owner_process_registered_at,
    lease_owner_process_start_time: session.lease_owner_process_start_time,
  };
}

/**
 * Whether the periodic sweep may end this active session. Age alone never ends;
 * stale-but-alive owners are kept even when a lease is held.
 */
export function shouldSweepEndSession(
  session: Pick<Session, "lease_holder_connection_id"> & Parameters<
    typeof classifySessionOwnerProcess
  >[0],
  options: SessionOwnerLivenessOptions = {},
): boolean {
  const ownerState = classifySessionOwnerProcess(session, options);
  if (ownerState === "live" || ownerState === "stale") return false;
  if (ownerState === "no_owner") {
    return session.lease_holder_connection_id == null;
  }
  // dead — end even when a connection lease is still stamped (crashed holder).
  return true;
}

export async function runSessionEndSweep(input: {
  storage: Storage;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  recencyMs?: number;
  /** Row-ender classification injectables (start-probe, recency, pid liveness). */
  ownerLivenessOptions?: SessionOwnerLivenessOptions;
  log?: (message: string) => void;
  /** Test hook: hold the sweep in-flight until released (session-end pass only). */
  sweepHold?: () => Promise<void>;
  /** AGE-101: lazy adapter scope reconciliation after session-end pass. */
  reconcile?: Omit<SessionScopeReconcileInput, "now">;
}): Promise<SessionEndSweepCounts> {
  const counts: SessionEndSweepCounts = {
    ended: 0,
    kept_live: 0,
    kept_stale: 0,
    kept_no_owner_leased: 0,
    cas_lost: 0,
  };
  const livenessOptions: SessionOwnerLivenessOptions = {
    now: input.now ?? input.ownerLivenessOptions?.now,
    isPidAlive: input.isPidAlive ?? input.ownerLivenessOptions?.isPidAlive,
    recencyMs: input.recencyMs ?? input.ownerLivenessOptions?.recencyMs,
    readProcessStartEpochMs: input.ownerLivenessOptions?.readProcessStartEpochMs,
    readProcStat: input.ownerLivenessOptions?.readProcStat,
    readBootId: input.ownerLivenessOptions?.readBootId,
    readProcUptime: input.ownerLivenessOptions?.readProcUptime,
    readClockTicksPerSec: input.ownerLivenessOptions?.readClockTicksPerSec,
  };
  const at = (input.now ?? Date.now)();
  const sessions = await input.storage.listSessions({ status: "active" });

  for (const session of sessions) {
    const ownerState = classifySessionOwnerProcess(session, livenessOptions);
    if (!shouldSweepEndSession(session, livenessOptions)) {
      if (ownerState === "live") counts.kept_live += 1;
      else if (ownerState === "stale") counts.kept_stale += 1;
      else if (
        ownerState === "no_owner" &&
        session.lease_holder_connection_id != null
      ) {
        counts.kept_no_owner_leased += 1;
      }
      continue;
    }

    const ended = await input.storage.endSessionIfUnchanged(
      session.session_id,
      sessionEndObservation(session),
      at,
    );
    if (ended) counts.ended += 1;
    else counts.cas_lost += 1;
  }

  if (input.sweepHold) {
    await input.sweepHold();
  }

  const log = input.log ?? (() => {});
  log(
    `agents-comm-bus: session end sweep: ended=${counts.ended} ` +
      `kept_live=${counts.kept_live} kept_stale=${counts.kept_stale} ` +
      `kept_no_owner_leased=${counts.kept_no_owner_leased} cas_lost=${counts.cas_lost}`,
  );

  if (input.reconcile) {
    counts.reconcile = await reconcileLazyAdapterScopes({
      ...input.reconcile,
      now: input.now,
      graceMs: input.reconcile.graceMs,
    });
    log(
      `agents-comm-bus: scope reconcile: zero_live=${counts.reconcile.scopes_zero_live} ` +
        `released=${counts.reconcile.scopes_released} ` +
        `adapters_removed=${counts.reconcile.adapters_removed} ` +
        `active_scopes_pruned=${counts.reconcile.active_scopes_pruned}`,
    );
  }

  return counts;
}

export interface SessionEndSweepHandle {
  stop(): void;
  /** AGE-101: explicit session-exit hint — next sweep reconciles without grace. */
  requestEarlyReconcile(): void;
}

export function startSessionEndSweep(options: {
  storage: Storage;
  intervalMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  recencyMs?: number;
  ownerLivenessOptions?: SessionOwnerLivenessOptions;
  log?: (message: string) => void;
  sweepHold?: () => Promise<void>;
  reconcile?: Omit<
    SessionScopeReconcileInput,
    "now" | "graceMs" | "scheduleGraceExpiry" | "cancelGraceExpiry"
  >;
  reconcileState?: ScopeReleaseReconcileState;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Run one sweep immediately on start (daemon boot). */
  runOnStart?: boolean;
}): SessionEndSweepHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SESSION_END_SWEEP_INTERVAL_MS;
  const setIntervalFn =
    options.setIntervalFn ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearIntervalFn =
    options.clearIntervalFn ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

  let sweepInFlight = false;
  let pendingTick = false;
  let stopped = false;
  let interval: unknown = null;
  let earlyReconcile = false;
  const reconcileState: ScopeReleaseReconcileState = options.reconcileState ?? {
    zeroLiveSince: new Map(),
    graceTimers: new Map(),
  };
  if (!reconcileState.graceTimers) {
    reconcileState.graceTimers = new Map();
  }

  const cancelGraceExpiry = (key: string): void => {
    const handle = reconcileState.graceTimers!.get(key);
    if (handle != null) {
      clearTimeoutFn(handle);
      reconcileState.graceTimers!.delete(key);
    }
  };

  const scheduleGraceExpiry = (key: string, delayMs: number): void => {
    if (stopped) return;
    cancelGraceExpiry(key);
    const handle = setTimeoutFn(() => {
      if (stopped) return;
      reconcileState.graceTimers!.delete(key);
      tick();
    }, delayMs);
    reconcileState.graceTimers!.set(key, handle);
  };

  const tick = (): void => {
    if (stopped) return;
    if (sweepInFlight) {
      pendingTick = true;
      return;
    }
    sweepInFlight = true;
    const graceMs = earlyReconcile ? 0 : undefined;
    earlyReconcile = false;
    void runSessionEndSweep({
      storage: options.storage,
      now: options.now,
      isPidAlive: options.isPidAlive,
      recencyMs: options.recencyMs,
      ownerLivenessOptions: options.ownerLivenessOptions,
      sweepHold: options.sweepHold,
      log: options.log,
      reconcile:
        options.reconcile != null
          ? {
              ...options.reconcile,
              state: reconcileState,
              graceMs,
              scheduleGraceExpiry,
              cancelGraceExpiry,
            }
          : undefined,
    })
      .catch((error) => {
        const log = options.log ?? console.error;
        log(
          `agents-comm-bus: session end sweep failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
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

  const initial = setTimeoutFn(() => {
    if (stopped) return;
    interval = setIntervalFn(tick, intervalMs);
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearTimeoutFn(initial);
      if (interval != null) clearIntervalFn(interval);
      interval = null;
      for (const key of reconcileState.graceTimers!.keys()) {
        cancelGraceExpiry(key);
      }
    },
    requestEarlyReconcile() {
      earlyReconcile = true;
      tick();
    },
  };
}

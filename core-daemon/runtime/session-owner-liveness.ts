import type { Session } from "agents-comm-bus-core";

import {
  compareProcessStartIdentity,
  type ProcessStartIdentityOptions,
} from "./process-start-epoch.js";

/** Match boot-scope restore's existing 24-hour owner recency window. */
export const DEFAULT_SESSION_OWNER_RECENCY_MS = 24 * 60 * 60 * 1000;

export type SessionOwnerRecord = Pick<
  Session,
  | "lease_holder_connection_id"
  | "lease_owner_process_pid"
  | "lease_owner_process_registered_at"
  | "lease_owner_process_start_time"
>;

export type SessionOwnerProcessState =
  | "live"
  | "no_owner"
  | "stale"
  | "dead";

export interface SessionOwnerLivenessOptions extends ProcessStartIdentityOptions {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** Injectable process-start probe (tests); defaults to readProcessStartEpochMs. */
  readProcessStartEpochMs?: (pid: number) => number | null;
  recencyMs?: number;
}

export type SessionOwnerLiveness = (session: SessionOwnerRecord) => boolean;

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify the durable process-owner stamp left behind after a short-lived
 * hook connection releases its lease. Keeping this pure and dependency-
 * injected lets routing and boot restore use the exact same rule.
 */
export function classifySessionOwnerProcess(
  session: SessionOwnerRecord,
  options: SessionOwnerLivenessOptions = {},
): SessionOwnerProcessState {
  const pid = session.lease_owner_process_pid;
  const registeredAt = session.lease_owner_process_registered_at;
  const startTime = session.lease_owner_process_start_time;
  if (pid == null || registeredAt == null) return "no_owner";

  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!isPidAlive(pid)) return "dead";

  if (startTime != null) {
    const identityOptions: ProcessStartIdentityOptions = {
      readProcStat: options.readProcStat,
      readBootId: options.readBootId,
      readProcUptime: options.readProcUptime,
      readClockTicksPerSec: options.readClockTicksPerSec,
    };
    const compare = options.readProcessStartEpochMs
      ? (() => {
          const current = options.readProcessStartEpochMs!(pid);
          if (current == null) return "inconclusive" as const;
          return current === startTime ? "match" : "mismatch";
        })()
      : compareProcessStartIdentity(startTime, pid, identityOptions);
    if (compare === "mismatch") return "dead";
    // Identity confirmed: the exact process that registered is still running.
    // Recency was only ever a pid-reuse proxy; with a start-time match it adds
    // nothing and would mark an idle-but-alive owner "stale", which the live
    // scope-release path then treated as gone (adapters stopped under a
    // running Claude session that had not submitted a prompt for 24h).
    if (compare === "match") return "live";
  }

  // No start-time identity (legacy rows) or an inconclusive probe: keep the
  // recency window as the pid-reuse guard.
  const now = options.now ?? Date.now;
  const recencyMs =
    options.recencyMs ?? DEFAULT_SESSION_OWNER_RECENCY_MS;
  if (now() - registeredAt > recencyMs) return "stale";

  return "live";
}

/**
 * A session is live for label-scope precedence while it has a live connection
 * lease OR a recent, still-running durable process owner. Claude hooks release
 * their connection lease after every IPC call, so the second signal is
 * load-bearing between prompts.
 */
export function createSessionOwnerLiveness(
  options: SessionOwnerLivenessOptions = {},
): SessionOwnerLiveness {
  return (session) =>
    session.lease_holder_connection_id != null ||
    classifySessionOwnerProcess(session, options) === "live";
}

import type { Session } from "agents-comm-bus-core";
import { type ProcessStartIdentityOptions } from "./process-start-epoch.js";
/** Match boot-scope restore's existing 24-hour owner recency window. */
export declare const DEFAULT_SESSION_OWNER_RECENCY_MS: number;
export type SessionOwnerRecord = Pick<Session, "lease_holder_connection_id" | "lease_owner_process_pid" | "lease_owner_process_registered_at" | "lease_owner_process_start_time">;
export type SessionOwnerProcessState = "live" | "no_owner" | "stale" | "dead";
export interface SessionOwnerLivenessOptions extends ProcessStartIdentityOptions {
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    /** Injectable process-start probe (tests); defaults to readProcessStartEpochMs. */
    readProcessStartEpochMs?: (pid: number) => number | null;
    recencyMs?: number;
}
export type SessionOwnerLiveness = (session: SessionOwnerRecord) => boolean;
export declare function defaultIsPidAlive(pid: number): boolean;
/**
 * Classify the durable process-owner stamp left behind after a short-lived
 * hook connection releases its lease. Keeping this pure and dependency-
 * injected lets routing and boot restore use the exact same rule.
 */
export declare function classifySessionOwnerProcess(session: SessionOwnerRecord, options?: SessionOwnerLivenessOptions): SessionOwnerProcessState;
/**
 * A session is live for label-scope precedence while it has a live connection
 * lease OR a recent, still-running durable process owner. Claude hooks release
 * their connection lease after every IPC call, so the second signal is
 * load-bearing between prompts.
 */
export declare function createSessionOwnerLiveness(options?: SessionOwnerLivenessOptions): SessionOwnerLiveness;
//# sourceMappingURL=session-owner-liveness.d.ts.map
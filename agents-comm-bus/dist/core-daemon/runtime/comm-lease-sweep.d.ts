import type { Storage } from "agents-comm-bus-core";
import type { JsonlAuditStore } from "../storage/audit.js";
import type { EnsureRegistrationContext } from "./ensure-registration.js";
import { commLeasePath, type LeaseRecord } from "./comm-lease.js";
import { type ProcessStartIdentityOptions } from "./process-start-epoch.js";
/** Default periodic comm-lease sweep interval. */
export declare const DEFAULT_COMM_LEASE_SWEEP_INTERVAL_MS: number;
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
export declare function classifyCommLeaseOwner(record: Pick<LeaseRecord, "pid" | "process_start_time">, options?: CommLeaseOwnerLivenessOptions): CommLeaseOwnerState;
export declare function commLeaseLockRoot(homeDir?: string): string;
export interface CommLeaseSweepRecoveryInput {
    storage: Storage;
    activeScopes: ReadonlySet<string>;
    ensure: EnsureRegistrationContext;
    audit?: JsonlAuditStore;
}
export declare function runCommLeaseSweep(input: {
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
}): Promise<CommLeaseSweepCounts>;
export interface CommLeaseSweepHandle {
    stop(): void;
}
export declare function startCommLeaseSweep(options: {
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
    setIntervalFn?: (fn: () => void, ms: number) => unknown;
    clearIntervalFn?: (handle: unknown) => void;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    /** Run one sweep immediately on start (daemon boot one-shot). */
    runOnStart?: boolean;
}): CommLeaseSweepHandle;
/** Resolve comm/resource ids from a lease path under the fixed comm-lock root. */
export declare function commLeaseIdsFromPath(leasePath: string, homeDir?: string): {
    comm_id: string;
    resource_id: string;
} | null;
export { commLeasePath };
//# sourceMappingURL=comm-lease-sweep.d.ts.map
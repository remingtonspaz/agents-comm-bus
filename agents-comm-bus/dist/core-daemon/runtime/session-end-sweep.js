import { classifySessionOwnerProcess, } from "./session-owner-liveness.js";
import { reconcileLazyAdapterScopes } from "./scope-release-reconcile.js";
/** Default periodic sweep interval — boot-only is insufficient for long-lived daemons. */
export const DEFAULT_SESSION_END_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export function sessionEndObservation(session) {
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
export function shouldSweepEndSession(session, options = {}) {
    const ownerState = classifySessionOwnerProcess(session, options);
    if (ownerState === "live" || ownerState === "stale")
        return false;
    if (ownerState === "no_owner") {
        return session.lease_holder_connection_id == null;
    }
    // dead — end even when a connection lease is still stamped (crashed holder).
    return true;
}
export async function runSessionEndSweep(input) {
    const counts = {
        ended: 0,
        kept_live: 0,
        kept_stale: 0,
        kept_no_owner_leased: 0,
        cas_lost: 0,
    };
    const livenessOptions = {
        now: input.now,
        isPidAlive: input.isPidAlive,
        recencyMs: input.recencyMs,
    };
    const at = (input.now ?? Date.now)();
    const sessions = await input.storage.listSessions({ status: "active" });
    for (const session of sessions) {
        const ownerState = classifySessionOwnerProcess(session, livenessOptions);
        if (!shouldSweepEndSession(session, livenessOptions)) {
            if (ownerState === "live")
                counts.kept_live += 1;
            else if (ownerState === "stale")
                counts.kept_stale += 1;
            else if (ownerState === "no_owner" &&
                session.lease_holder_connection_id != null) {
                counts.kept_no_owner_leased += 1;
            }
            continue;
        }
        const ended = await input.storage.endSessionIfUnchanged(session.session_id, sessionEndObservation(session), at);
        if (ended)
            counts.ended += 1;
        else
            counts.cas_lost += 1;
    }
    const log = input.log ?? (() => { });
    log(`agents-comm-bus: session end sweep: ended=${counts.ended} ` +
        `kept_live=${counts.kept_live} kept_stale=${counts.kept_stale} ` +
        `kept_no_owner_leased=${counts.kept_no_owner_leased} cas_lost=${counts.cas_lost}`);
    if (input.reconcile) {
        counts.reconcile = await reconcileLazyAdapterScopes({
            ...input.reconcile,
            now: input.now,
            graceMs: input.reconcile.graceMs,
        });
        log(`agents-comm-bus: scope reconcile: zero_live=${counts.reconcile.scopes_zero_live} ` +
            `released=${counts.reconcile.scopes_released} ` +
            `adapters_removed=${counts.reconcile.adapters_removed} ` +
            `active_scopes_pruned=${counts.reconcile.active_scopes_pruned}`);
    }
    return counts;
}
export function startSessionEndSweep(options) {
    const intervalMs = options.intervalMs ?? DEFAULT_SESSION_END_SWEEP_INTERVAL_MS;
    const setIntervalFn = options.setIntervalFn ??
        ((fn, ms) => {
            const handle = setInterval(fn, ms);
            handle.unref?.();
            return handle;
        });
    const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));
    const setTimeoutFn = options.setTimeoutFn ??
        ((fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        });
    const clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
    let sweepInFlight = false;
    let interval = null;
    let earlyReconcile = false;
    const reconcileState = options.reconcileState ?? {
        zeroLiveSince: new Map(),
        graceTimers: new Map(),
    };
    if (!reconcileState.graceTimers) {
        reconcileState.graceTimers = new Map();
    }
    const cancelGraceExpiry = (key) => {
        const handle = reconcileState.graceTimers.get(key);
        if (handle != null) {
            clearTimeoutFn(handle);
            reconcileState.graceTimers.delete(key);
        }
    };
    const scheduleGraceExpiry = (key, delayMs) => {
        cancelGraceExpiry(key);
        const handle = setTimeoutFn(() => {
            reconcileState.graceTimers.delete(key);
            tick();
        }, delayMs);
        reconcileState.graceTimers.set(key, handle);
    };
    const tick = () => {
        if (sweepInFlight)
            return;
        sweepInFlight = true;
        const graceMs = earlyReconcile ? 0 : undefined;
        earlyReconcile = false;
        void runSessionEndSweep({
            storage: options.storage,
            now: options.now,
            isPidAlive: options.isPidAlive,
            recencyMs: options.recencyMs,
            log: options.log,
            reconcile: options.reconcile != null
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
            log(`agents-comm-bus: session end sweep failed: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        })
            .finally(() => {
            sweepInFlight = false;
        });
    };
    if (options.runOnStart !== false) {
        tick();
    }
    const initial = setTimeoutFn(() => {
        interval = setIntervalFn(tick, intervalMs);
    }, intervalMs);
    return {
        stop() {
            clearTimeoutFn(initial);
            if (interval != null)
                clearIntervalFn(interval);
            interval = null;
            for (const key of reconcileState.graceTimers.keys()) {
                cancelGraceExpiry(key);
            }
        },
        requestEarlyReconcile() {
            earlyReconcile = true;
            tick();
        },
    };
}
//# sourceMappingURL=session-end-sweep.js.map
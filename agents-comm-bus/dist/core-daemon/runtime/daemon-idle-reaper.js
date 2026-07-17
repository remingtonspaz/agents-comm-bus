/** Default continuous-idle grace before a stray daemon self-retires (AGE-36). */
export const DEFAULT_IDLE_REAPER_GRACE_MS = 90_000;
export const DEFAULT_IDLE_REAPER_INTERVAL_MS = 5_000;
/**
 * Pure structural eligibility — runtime-local blockers only. IPC recency is
 * evaluated separately so retirement needs one grace after structural clearance
 * AND IPC quiet, not ~2x grace from last activity.
 */
export function sampleStructuralEligibility(input) {
    const heldLeases = input.heldLeaseCount();
    const liveIpcConnections = input.liveIpcConnectionCount();
    const pendingInbound = input.pendingInboundLength();
    const inFlightAdapters = input.inFlightAdapterCount();
    const rawBridgeBlockers = input.bridgeBlockers();
    const bridgeBlockers = {};
    for (const [agentId, snapshot] of Object.entries(rawBridgeBlockers)) {
        if (snapshot)
            bridgeBlockers[agentId] = snapshot;
    }
    const ipcQuietForGrace = input.now - input.lastIpcServedAt >= input.graceMs;
    const reasons = [];
    if (heldLeases > 0)
        reasons.push("held_leases");
    if (liveIpcConnections > 0)
        reasons.push("live_ipc_connections");
    if (pendingInbound > 0)
        reasons.push("pending_inbound");
    if (inFlightAdapters > 0)
        reasons.push("in_flight_adapters");
    if (Object.keys(bridgeBlockers).length > 0)
        reasons.push("bridge_blockers");
    return {
        structurallyEligible: reasons.length === 0,
        blockers: {
            held_leases: heldLeases,
            live_ipc_connections: liveIpcConnections,
            pending_inbound: pendingInbound,
            in_flight_adapters: inFlightAdapters,
            bridge_blockers: bridgeBlockers,
            ipc_quiet_for_grace: ipcQuietForGrace,
        },
        reasons,
    };
}
/** @deprecated Use sampleStructuralEligibility — kept for transitional imports. */
export function sampleIdleReaperEligibility(input) {
    const result = sampleStructuralEligibility(input);
    const ipcReason = result.blockers.ipc_quiet_for_grace ? [] : ["ipc_not_quiet_for_grace"];
    return {
        ...result,
        eligible: result.structurallyEligible && result.blockers.ipc_quiet_for_grace,
        reasons: [...result.reasons, ...ipcReason],
    };
}
export function shouldIdleReaperRetire(input) {
    if (!input.structurallyEligible || input.structuralEligibleSince === null)
        return false;
    return (input.now - input.structuralEligibleSince >= input.graceMs &&
        input.now - input.lastIpcServedAt >= input.graceMs);
}
export function startIdleReaper(options) {
    const graceMs = options.graceMs ?? DEFAULT_IDLE_REAPER_GRACE_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_IDLE_REAPER_INTERVAL_MS;
    const nowFn = options.now ?? Date.now;
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
    const log = options.log ?? (() => { });
    let structuralEligibleSince = null;
    let retired = false;
    let interval = null;
    const tick = () => {
        if (retired)
            return;
        const now = nowFn();
        const structural = sampleStructuralEligibility({
            now,
            lastIpcServedAt: options.lastIpcServedAt(),
            graceMs,
            heldLeaseCount: options.heldLeaseCount,
            liveIpcConnectionCount: options.liveIpcConnectionCount,
            pendingInboundLength: options.pendingInboundLength,
            inFlightAdapterCount: options.inFlightAdapterCount,
            bridgeBlockers: options.bridgeBlockers,
        });
        if (!structural.structurallyEligible) {
            structuralEligibleSince = null;
            return;
        }
        if (structuralEligibleSince === null) {
            structuralEligibleSince = now;
        }
        if (shouldIdleReaperRetire({
            now,
            graceMs,
            structuralEligibleSince,
            lastIpcServedAt: options.lastIpcServedAt(),
            structurallyEligible: true,
        })) {
            retired = true;
            log(`agents-comm-bus: idle reaper retiring daemon after ${graceMs}ms with no owned resources ` +
                `(structural blockers cleared at ${new Date(structuralEligibleSince).toISOString()})`);
            void Promise.resolve(options.retire()).catch((error) => {
                console.error(`agents-comm-bus: idle reaper retire failed: ` +
                    `${error instanceof Error ? error.message : String(error)}`);
            });
        }
    };
    const initialDelayMs = options.initialDelayMs ?? intervalMs;
    const initial = setTimeoutFn(() => {
        tick();
        interval = setIntervalFn(tick, intervalMs);
    }, initialDelayMs);
    return {
        stop() {
            clearTimeoutFn(initial);
            if (interval != null)
                clearIntervalFn(interval);
            interval = null;
        },
    };
}
//# sourceMappingURL=daemon-idle-reaper.js.map
import { readProcessStartEpochMs } from "./process-start-epoch.js";
/** Match boot-scope restore's existing 24-hour owner recency window. */
export const DEFAULT_SESSION_OWNER_RECENCY_MS = 24 * 60 * 60 * 1000;
export function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Classify the durable process-owner stamp left behind after a short-lived
 * hook connection releases its lease. Keeping this pure and dependency-
 * injected lets routing and boot restore use the exact same rule.
 */
export function classifySessionOwnerProcess(session, options = {}) {
    const pid = session.lease_owner_process_pid;
    const registeredAt = session.lease_owner_process_registered_at;
    const startTime = session.lease_owner_process_start_time;
    if (pid == null || registeredAt == null)
        return "no_owner";
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    if (!isPidAlive(pid))
        return "dead";
    if (startTime != null) {
        const readStart = options.readProcessStartEpochMs ?? readProcessStartEpochMs;
        const currentStart = readStart(pid);
        if (currentStart != null && currentStart !== startTime)
            return "dead";
    }
    const now = options.now ?? Date.now;
    const recencyMs = options.recencyMs ?? DEFAULT_SESSION_OWNER_RECENCY_MS;
    if (now() - registeredAt > recencyMs)
        return "stale";
    return "live";
}
/**
 * A session is live for label-scope precedence while it has a live connection
 * lease OR a recent, still-running durable process owner. Claude hooks release
 * their connection lease after every IPC call, so the second signal is
 * load-bearing between prompts.
 */
export function createSessionOwnerLiveness(options = {}) {
    return (session) => session.lease_holder_connection_id != null ||
        classifySessionOwnerProcess(session, options) === "live";
}
//# sourceMappingURL=session-owner-liveness.js.map
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
    if (pid == null || registeredAt == null)
        return "no_owner";
    const now = options.now ?? Date.now;
    const recencyMs = options.recencyMs ?? DEFAULT_SESSION_OWNER_RECENCY_MS;
    if (now() - registeredAt > recencyMs)
        return "stale";
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    // TODO(AGE-55): process-start-time verification would close PID reuse inside
    // the recency window; Node has no clean cross-platform built-in for it.
    return isPidAlive(pid) ? "live" : "dead";
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
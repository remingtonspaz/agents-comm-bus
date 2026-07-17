/**
 * Daemon-local open-query inventory for Claude retirement eligibility (AGE-36).
 * Tracks query ids only after a successful bus.openQuery; clears on resolve,
 * supersede, send-cancel, and TTL expiry.
 */
export class ClaudeOpenQueryTracker {
    openQueriesBySession = new Map();
    querySessions = new Map();
    queryTtlTimers = new Map();
    setTimeoutFn;
    clearTimeoutFn;
    constructor(options = {}) {
        this.setTimeoutFn =
            options.setTimeoutFn ??
                ((fn, ms) => {
                    const handle = setTimeout(fn, ms);
                    handle.unref?.();
                    return handle;
                });
        this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
    }
    openQueryCount() {
        let count = 0;
        for (const set of this.openQueriesBySession.values())
            count += set.size;
        return count;
    }
    getRetirementBlockers() {
        const count = this.openQueryCount();
        return count > 0 ? { open_queries: count } : null;
    }
    trackOpenQuery(session, queryId, ttlSeconds) {
        let set = this.openQueriesBySession.get(session);
        if (!set) {
            set = new Set();
            this.openQueriesBySession.set(session, set);
        }
        set.add(queryId);
        this.querySessions.set(queryId, session);
        const ttlMs = Math.max(1, Math.round(ttlSeconds * 1000));
        const timer = this.setTimeoutFn(() => {
            this.clearOpenQuery(queryId);
        }, ttlMs);
        this.queryTtlTimers.set(queryId, timer);
    }
    clearOpenQuery(queryId) {
        const timer = this.queryTtlTimers.get(queryId);
        if (timer != null) {
            this.clearTimeoutFn(timer);
            this.queryTtlTimers.delete(queryId);
        }
        const session = this.querySessions.get(queryId);
        this.querySessions.delete(queryId);
        if (!session)
            return;
        const set = this.openQueriesBySession.get(session);
        if (!set)
            return;
        set.delete(queryId);
        if (set.size === 0)
            this.openQueriesBySession.delete(session);
    }
    clearOpenQueriesForSession(session) {
        const set = this.openQueriesBySession.get(session);
        if (!set)
            return;
        for (const queryId of [...set]) {
            this.clearOpenQuery(queryId);
        }
    }
}
//# sourceMappingURL=open-query-tracker.js.map
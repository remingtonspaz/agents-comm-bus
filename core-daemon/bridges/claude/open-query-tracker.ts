import type { QueryId, SessionId } from "agents-comm-bus-core";

import type { RetirementBlockerSnapshot } from "../../runtime/agent-bridge.js";

export interface OpenQueryTrackerOptions {
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Daemon-local open-query inventory for Claude retirement eligibility (AGE-36).
 * Tracks query ids only after a successful bus.openQuery; clears on resolve,
 * supersede, send-cancel, and TTL expiry.
 */
export class ClaudeOpenQueryTracker {
  private readonly openQueriesBySession = new Map<SessionId, Set<QueryId>>();
  private readonly querySessions = new Map<QueryId, SessionId>();
  private readonly queryTtlTimers = new Map<QueryId, unknown>();
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(options: OpenQueryTrackerOptions = {}) {
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  }

  openQueryCount(): number {
    let count = 0;
    for (const set of this.openQueriesBySession.values()) count += set.size;
    return count;
  }

  getRetirementBlockers(): RetirementBlockerSnapshot | null {
    const count = this.openQueryCount();
    return count > 0 ? { open_queries: count } : null;
  }

  trackOpenQuery(session: SessionId, queryId: QueryId, ttlSeconds: number): void {
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

  clearOpenQuery(queryId: QueryId): void {
    const timer = this.queryTtlTimers.get(queryId);
    if (timer != null) {
      this.clearTimeoutFn(timer);
      this.queryTtlTimers.delete(queryId);
    }
    const session = this.querySessions.get(queryId);
    this.querySessions.delete(queryId);
    if (!session) return;
    const set = this.openQueriesBySession.get(session);
    if (!set) return;
    set.delete(queryId);
    if (set.size === 0) this.openQueriesBySession.delete(session);
  }

  clearOpenQueriesForSession(session: SessionId): void {
    const set = this.openQueriesBySession.get(session);
    if (!set) return;
    for (const queryId of [...set]) {
      this.clearOpenQuery(queryId);
    }
  }
}

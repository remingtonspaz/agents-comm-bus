import type { Query, ResolvedDecision } from "./queries.js";
import type { ChatRef, MessageId, QueryId } from "./types.js";

/**
 * Pure functions encoding v4 query/lease semantics. No IO, no clocks (the
 * caller passes `now`). Used by the bus to enforce invariants and by tests
 * to pin down the rules.
 */

export type ResolveResult =
  | { kind: "accepted" }
  | {
      kind: "rejected";
      reason: "already_resolved" | "expired" | "wrong_chat";
    };

/**
 * v4 rule: TTL fail-closed. A query is expired once
 * `created_at + ttl_seconds*1000 <= now`. Callers MUST treat expired queries
 * as unresolvable; the bus garbage-collects them.
 */
export function isExpired(query: Query, now: number): boolean {
  return query.created_at + query.ttl_seconds * 1000 <= now;
}

/**
 * v4 rule: resolved-once semantics. A query may transition from open ->
 * resolved exactly once. Re-resolution attempts are rejected.
 *
 * Rejection order (deterministic): already_resolved > expired > wrong_chat.
 * The chat check enforces v4's "same-chat match" rule: a resolution must
 * arrive from the same `(comm, account, chat_native_id, thread_native_id)`
 * tuple as the query's `origin_chat` when that origin is recorded.
 */
export function tryResolve(
  query: Query,
  decision: ResolvedDecision,
  now: number,
): ResolveResult {
  if (query.resolution !== undefined) {
    return { kind: "rejected", reason: "already_resolved" };
  }
  if (isExpired(query, now)) {
    return { kind: "rejected", reason: "expired" };
  }
  if (query.origin_chat !== undefined && !sameChat(query.origin_chat, decision.decided_in_chat)) {
    return { kind: "rejected", reason: "wrong_chat" };
  }
  return { kind: "accepted" };
}

/**
 * v4 rule: same-chat reply targeting. A Telegram (or other comm) reply
 * targets this query iff it arrives in the same chat tuple AND, when the
 * query has a `source_message_id`, the reply is `reply_to` that message.
 * When no `source_message_id` is recorded (free-text query in same chat),
 * any reply in the same chat matches.
 */
export function matchReplyToQuery(
  query: Query,
  replyChat: ChatRef,
  replyToMessageId: MessageId | undefined,
): boolean {
  if (query.origin_chat === undefined) return false;
  if (!sameChat(query.origin_chat, replyChat)) return false;
  if (query.source_message_id === undefined) return true;
  return replyToMessageId === query.source_message_id;
}

/**
 * v4 rule: at most one open query per session. Mirrors the SQL partial
 * unique index that the daemon will enforce; exposed here as a predicate
 * so producers can check before issuing a new query.
 */
export function hasOpenQuery(
  openQueriesBySession: ReadonlyMap<string, Query>,
  session: string,
): boolean {
  return openQueriesBySession.has(session);
}

/**
 * v4 rule: connection-lifetime lease. When an adapter connection closes,
 * any open queries it held become orphaned and must be marked expired so
 * the bus does not block waiting for a now-unreachable owner.
 */
export function clearOwnershipOnDisconnect(
  closedConnectionId: string,
  openQueries: ReadonlyArray<{ query: Query; held_by_connection_id: string }>,
): QueryId[] {
  const result: QueryId[] = [];
  for (const entry of openQueries) {
    if (entry.held_by_connection_id === closedConnectionId) {
      result.push(entry.query.query_id);
    }
  }
  return result;
}

function sameChat(a: ChatRef, b: ChatRef): boolean {
  return (
    a.comm === b.comm &&
    a.account === b.account &&
    a.chat_native_id === b.chat_native_id &&
    a.thread_native_id === b.thread_native_id
  );
}

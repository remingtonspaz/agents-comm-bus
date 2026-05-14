import type {
  AccountId,
  AgentId,
  ChatRef,
  CommId,
  Message,
  SessionId,
} from "./types.js";

/**
 * A routing binding maps a (partial) message identity to an (agent, session) target.
 *
 * Each optional field is a *constraint*: when present, the corresponding field on
 * the inbound message must equal it for the binding to match. A binding with no
 * constraints (no fields set besides `target` / `created_at`) matches every
 * message and acts as a default route.
 */
export interface Binding {
  agent?: AgentId;
  session?: SessionId;
  comm?: CommId;
  account?: AccountId;
  chat?: string;
  thread?: string;
  sender?: string;
  target: { agent: AgentId; session: SessionId };
  created_at: number;
}

/**
 * Last-active anchor map. Key is `${agent}:${session}`; value is the most-recent
 * inbound `ChatRef` observed for that target. Used as fallback when no binding
 * matches a message.
 */
export type LastActiveAnchor = Map<string, ChatRef>;

/** Number of constraint fields set on a binding (excluding target / created_at). */
function specificity(b: Binding): number {
  let n = 0;
  if (b.agent !== undefined) n++;
  if (b.session !== undefined) n++;
  if (b.comm !== undefined) n++;
  if (b.account !== undefined) n++;
  if (b.chat !== undefined) n++;
  if (b.thread !== undefined) n++;
  if (b.sender !== undefined) n++;
  return n;
}

/** True iff every constraint on `b` is satisfied by `m`. */
function matches(b: Binding, m: Message): boolean {
  if (b.comm !== undefined && b.comm !== m.chat.comm) return false;
  if (b.account !== undefined && b.account !== m.chat.account) return false;
  if (b.chat !== undefined && b.chat !== m.chat.id) return false;
  if (b.thread !== undefined && b.thread !== m.chat.thread_id) return false;
  if (b.sender !== undefined && b.sender !== m.sender.id) return false;
  if (b.agent !== undefined && b.agent !== m.origin.agent) return false;
  if (b.session !== undefined && b.session !== m.origin.session) return false;
  return true;
}

function chatRefEquals(a: ChatRef, b: ChatRef): boolean {
  return (
    a.comm === b.comm &&
    a.account === b.account &&
    a.id === b.id &&
    a.thread_id === b.thread_id
  );
}

/**
 * Resolve a message to a target (agent, session) using the precedence:
 *
 *   1. Most-specific matching binding wins.
 *   2. Among ties, the earliest `created_at` wins.
 *   3. If nothing matches, fall back to `lastActive`: any anchor whose ChatRef
 *      equals `message.chat` returns the parsed `(agent, session)` of its key.
 *   4. Otherwise null.
 */
export function resolveRoute(
  message: Message,
  bindings: readonly Binding[],
  lastActive: LastActiveAnchor,
): { agent: AgentId; session: SessionId } | null {
  let best: Binding | null = null;
  let bestSpec = -1;
  for (const b of bindings) {
    if (!matches(b, message)) continue;
    const s = specificity(b);
    if (s > bestSpec || (s === bestSpec && best !== null && b.created_at < best.created_at)) {
      best = b;
      bestSpec = s;
    }
  }
  if (best !== null) {
    return { agent: best.target.agent, session: best.target.session };
  }

  for (const [key, ref] of lastActive) {
    if (chatRefEquals(ref, message.chat)) {
      const idx = key.indexOf(":");
      if (idx <= 0) continue;
      const agent = key.slice(0, idx);
      const session = key.slice(idx + 1);
      return { agent, session };
    }
  }

  return null;
}

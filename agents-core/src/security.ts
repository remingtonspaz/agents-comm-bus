import type { AgentId, Message, MessageId, Sender } from "./types.js";

export const MAX_HOP_COUNT = 4;

/**
 * Local hop-limit error. Phase 0 ships this as a plain Error subclass because
 * `errors.ts` is a stub in this unit. Later phases swap to `PermanentFailure`.
 */
class HopLimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HopLimitExceeded";
  }
}

/** Returns a shallow copy of `message` with `hop_count` incremented by 1. */
export function incrementHop(message: Message): Message {
  return { ...message, hop_count: message.hop_count + 1 };
}

/** Throws `HopLimitExceeded` when `message.hop_count` exceeds `MAX_HOP_COUNT`. */
export function enforceMaxHops(message: Message): void {
  if (message.hop_count > MAX_HOP_COUNT) {
    throw new HopLimitExceeded(
      `hop_count ${message.hop_count} exceeds MAX_HOP_COUNT ${MAX_HOP_COUNT}`,
    );
  }
}

/**
 * TTL-bounded set of recently-seen message ids. Used to suppress duplicate
 * delivery of messages observed within a short window.
 */
export class RecentlySeen {
  private readonly entries = new Map<MessageId, number>();

  constructor(
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true if `id` was marked within the TTL window. */
  seen(id: MessageId): boolean {
    const ts = this.entries.get(id);
    if (ts === undefined) return false;
    if (this.now() - ts > this.ttlMs) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  /** Records `id` at the current timestamp; prunes expired entries. */
  mark(id: MessageId): void {
    const current = this.now();
    for (const [key, ts] of this.entries) {
      if (current - ts > this.ttlMs) this.entries.delete(key);
    }
    this.entries.set(id, current);
  }
}

/**
 * Default-deny cross-agent delivery gate.
 *
 * Returns true only for:
 *   - own output (origin.agent === currentAgent), or
 *   - human input (sender.isBot === false).
 *
 * All other cases (sibling-agent output, foreign bots, unknown origin) are denied.
 */
export function shouldDeliverCrossAgent(
  message: Message,
  currentAgent: AgentId,
): boolean {
  if (message.origin.agent === currentAgent) return true;
  if (message.sender.isBot === false) return true;
  return false;
}

/**
 * Returns a shallow copy of `sender`. If the sender is a bot whose id is not in
 * `knownBotIds`, sets `isForeignBot: true`. Otherwise preserves the existing
 * `isForeignBot` value (defaulting to false).
 */
export function tagForeignBot(
  sender: Sender,
  knownBotIds: ReadonlySet<string>,
): Sender {
  if (sender.isBot && !knownBotIds.has(sender.id)) {
    return { ...sender, isForeignBot: true };
  }
  return { ...sender };
}

import type { AgentId, MessageId } from "./types.js";
import type { Message } from "./messages.js";

export const MAX_HOP_COUNT = 4 as const;

export interface SubscriptionRule {
  fromAgent: AgentId;
  toAgent: AgentId;
}

/**
 * Default-deny cross-agent delivery. An agent can only deliver to another
 * agent if an explicit subscription rule exists (or it's delivering to itself).
 */
export function isCrossAgentAllowed(
  originAgent: AgentId,
  targetAgent: AgentId,
  subscriptions: readonly SubscriptionRule[],
): boolean {
  if (originAgent === targetAgent) return true;
  return subscriptions.some(
    (s) => s.fromAgent === originAgent && s.toAgent === targetAgent,
  );
}

/**
 * Every message must carry an origin label (either an agent or a comm).
 * Throws if neither is present.
 */
export function assertHasOrigin(message: Message): void {
  if (!message.origin || (!message.origin.agent && !message.origin.comm)) {
    throw new Error("Message missing origin label");
  }
}

/** Returns a new message with hop_count + 1. Does not mutate the input. */
export function incrementHop(message: Message): Message {
  return { ...message, hop_count: message.hop_count + 1 };
}

/** True when the message has reached or exceeded the hop-limit and must be dropped. */
export function shouldDropForHopLimit(message: Message): boolean {
  return message.hop_count >= MAX_HOP_COUNT;
}

/**
 * Recently-seen dedupe cache. Tracks opaque string keys with a TTL so
 * duplicate deliveries within the window are recognized and dropped.
 *
 * Callers should choose a key that disambiguates the deliveries they want
 * to dedup. Plain `message_id` is wrong for multi-adapter setups where the
 * same platform message reaches more than one of the host's adapters (e.g.
 * the same Telegram group message polled by two bots both attached to the
 * daemon) — those are distinct logical inbounds and each adapter's
 * delivery should land separately. Scope the key by adapter / account in
 * those cases, e.g. `${comm}:${accountId}:${message_id}`.
 */
export class RecentSeenCache {
  private readonly seenMap = new Map<string, number>();

  constructor(private readonly ttlMs: number = 60_000) {}

  /** True if the key is currently tracked. Also evicts expired entries. */
  seen(key: string, now: number): boolean {
    this.evict(now);
    return this.seenMap.has(key);
  }

  /** Record a key at time `now`. Also evicts expired entries. */
  record(key: string, now: number): void {
    this.evict(now);
    this.seenMap.set(key, now);
  }

  private evict(now: number): void {
    for (const [id, ts] of this.seenMap) {
      if (now - ts > this.ttlMs) this.seenMap.delete(id);
    }
  }
}

export interface ForeignBotPolicy {
  allowForeignBots: boolean;
  allowedBotIds?: ReadonlyArray<string>;
}

export const DEFAULT_FOREIGN_BOT_POLICY: ForeignBotPolicy = {
  allowForeignBots: false,
};

/**
 * Foreign-bot policy gate. Non-foreign-bot senders are always allowed.
 * Foreign-bot senders are allowed only if the policy opens the gate, either
 * globally (allowForeignBots) or via an allowlist (allowedBotIds).
 */
export function isForeignBotAllowed(
  sender: { id: string; isForeignBot: boolean },
  policy: ForeignBotPolicy = DEFAULT_FOREIGN_BOT_POLICY,
): boolean {
  if (!sender.isForeignBot) return true;
  if (policy.allowForeignBots) return true;
  return policy.allowedBotIds?.includes(sender.id) ?? false;
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FOREIGN_BOT_POLICY,
  MAX_HOP_COUNT,
  RecentSeenCache,
  assertHasOrigin,
  incrementHop,
  isCrossAgentAllowed,
  isForeignBotAllowed,
  shouldDropForHopLimit,
  type SubscriptionRule,
} from "../../packages/core-contracts/src/security.js";
import type { Message } from "../../packages/core-contracts/src/messages.js";
import type {
  AccountId,
  AgentId,
  CommId,
  MessageId,
} from "../../packages/core-contracts/src/types.js";

function makeMessage(overrides: Partial<Message> = {}): Message {
  const base: Message = {
    schema_version: 1,
    message_id: "m1" as MessageId,
    chat: {
      comm: "telegram" as CommId,
      account: "acct1" as AccountId,
      chat_native_id: "chat-1",
    },
    sender: { id: "u1", isBot: false, isForeignBot: false },
    origin: { agent: "claude" as AgentId },
    hop_count: 0,
    received_at: 0,
  };
  return { ...base, ...overrides };
}

const AGENT_A = "agentA" as AgentId;
const AGENT_B = "agentB" as AgentId;
const AGENT_C = "agentC" as AgentId;

describe("isCrossAgentAllowed", () => {
  it("returns true for same-agent delivery", () => {
    assert.equal(isCrossAgentAllowed(AGENT_A, AGENT_A, []), true);
  });

  it("returns false with no subscriptions (default-deny)", () => {
    assert.equal(isCrossAgentAllowed(AGENT_A, AGENT_B, []), false);
  });

  it("returns true when a matching subscription exists", () => {
    const subs: SubscriptionRule[] = [{ fromAgent: AGENT_A, toAgent: AGENT_B }];
    assert.equal(isCrossAgentAllowed(AGENT_A, AGENT_B, subs), true);
  });

  it("returns false when subscriptions don't match the pair", () => {
    const subs: SubscriptionRule[] = [{ fromAgent: AGENT_A, toAgent: AGENT_C }];
    assert.equal(isCrossAgentAllowed(AGENT_A, AGENT_B, subs), false);
  });
});

describe("assertHasOrigin", () => {
  it("throws when origin has neither agent nor comm", () => {
    const m = makeMessage({ origin: {} });
    assert.throws(() => assertHasOrigin(m), /Message missing origin label/);
  });

  it("does not throw when origin.agent is set", () => {
    const m = makeMessage({ origin: { agent: "claude" as AgentId } });
    assert.doesNotThrow(() => assertHasOrigin(m));
  });

  it("does not throw when origin.comm is set", () => {
    const m = makeMessage({ origin: { comm: "telegram" as CommId } });
    assert.doesNotThrow(() => assertHasOrigin(m));
  });
});

describe("incrementHop", () => {
  it("returns a new message with hop_count + 1 and does not mutate", () => {
    const m = makeMessage({ hop_count: 2 });
    const out = incrementHop(m);
    assert.equal(out.hop_count, 3);
    assert.equal(m.hop_count, 2);
    assert.notEqual(out, m);
  });
});

describe("shouldDropForHopLimit", () => {
  it("is false for hop_count below MAX_HOP_COUNT", () => {
    for (let i = 0; i < MAX_HOP_COUNT; i++) {
      assert.equal(shouldDropForHopLimit(makeMessage({ hop_count: i })), false);
    }
  });

  it("is true at MAX_HOP_COUNT", () => {
    assert.equal(
      shouldDropForHopLimit(makeMessage({ hop_count: MAX_HOP_COUNT })),
      true,
    );
  });
});

describe("RecentSeenCache", () => {
  it("returns false initially, true after record, and false after TTL expiry", () => {
    const cache = new RecentSeenCache(1000);
    const id = "msg-1" as MessageId;

    assert.equal(cache.seen(id, 0), false);
    cache.record(id, 0);
    assert.equal(cache.seen(id, 500), true);
    // advance past TTL
    assert.equal(cache.seen(id, 2000), false);
  });
});

describe("isForeignBotAllowed", () => {
  it("allows non-foreign-bot senders regardless of policy", () => {
    const sender = { id: "u1", isForeignBot: false };
    assert.equal(isForeignBotAllowed(sender), true);
    assert.equal(
      isForeignBotAllowed(sender, { allowForeignBots: false }),
      true,
    );
  });

  it("denies foreign-bot senders under the default policy", () => {
    const sender = { id: "bot1", isForeignBot: true };
    assert.equal(isForeignBotAllowed(sender, DEFAULT_FOREIGN_BOT_POLICY), false);
    // default arg
    assert.equal(isForeignBotAllowed(sender), false);
  });

  it("allows a foreign-bot whose id is in allowedBotIds", () => {
    const sender = { id: "bot1", isForeignBot: true };
    const policy = { allowForeignBots: false, allowedBotIds: ["bot1"] };
    assert.equal(isForeignBotAllowed(sender, policy), true);
  });

  it("allows any foreign-bot when allowForeignBots is true", () => {
    const sender = { id: "bot-random", isForeignBot: true };
    assert.equal(
      isForeignBotAllowed(sender, { allowForeignBots: true }),
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  MAX_HOP_COUNT,
  RecentlySeen,
  enforceMaxHops,
  incrementHop,
  shouldDeliverCrossAgent,
  tagForeignBot,
} from "../../agents-core/src/security.js";
import {
  SCHEMA_VERSION_MESSAGE,
  type Message,
  type Sender,
} from "../../agents-core/src/types.js";

function makeSender(overrides: Partial<Sender> = {}): Sender {
  return {
    id: "sender-1",
    isBot: false,
    isForeignBot: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    schema_version: SCHEMA_VERSION_MESSAGE,
    message_id: "msg-1",
    chat: { comm: "telegram", account: "acct-1", id: "chat-1" },
    sender: makeSender(),
    origin: {},
    hop_count: 0,
    received_at: 0,
    ...overrides,
  };
}

describe("shouldDeliverCrossAgent", () => {
  it("allows self-bounce: origin.agent === currentAgent", () => {
    const msg = makeMessage({
      origin: { agent: "A" },
      sender: makeSender({ isBot: true }),
    });
    expect(shouldDeliverCrossAgent(msg, "A")).toBe(true);
  });

  it("denies sibling bounce: bot sender from other agent", () => {
    const msg = makeMessage({
      origin: { agent: "B" },
      sender: makeSender({ isBot: true }),
    });
    expect(shouldDeliverCrossAgent(msg, "A")).toBe(false);
  });

  it("allows human input regardless of origin", () => {
    const msgNoOrigin = makeMessage({
      sender: makeSender({ isBot: false }),
    });
    expect(shouldDeliverCrossAgent(msgNoOrigin, "A")).toBe(true);

    const msgOtherOrigin = makeMessage({
      origin: { agent: "B" },
      sender: makeSender({ isBot: false }),
    });
    expect(shouldDeliverCrossAgent(msgOtherOrigin, "A")).toBe(true);
  });

  it("denies unknown / foreign bot origin by default", () => {
    const msg = makeMessage({
      origin: {},
      sender: makeSender({ isBot: true, isForeignBot: true }),
    });
    expect(shouldDeliverCrossAgent(msg, "A")).toBe(false);
  });
});

describe("enforceMaxHops / incrementHop", () => {
  it("incrementHop returns shallow copy with hop_count + 1", () => {
    const msg = makeMessage({ hop_count: 2 });
    const next = incrementHop(msg);
    expect(next.hop_count).toBe(3);
    expect(msg.hop_count).toBe(2);
    expect(next).not.toBe(msg);
    expect(next.message_id).toBe(msg.message_id);
  });

  it("enforceMaxHops is a no-op when hop_count <= MAX_HOP_COUNT", () => {
    expect(() => enforceMaxHops(makeMessage({ hop_count: 0 }))).not.toThrow();
    expect(() =>
      enforceMaxHops(makeMessage({ hop_count: MAX_HOP_COUNT })),
    ).not.toThrow();
  });

  it("enforceMaxHops throws when hop_count > MAX_HOP_COUNT", () => {
    expect(() =>
      enforceMaxHops(makeMessage({ hop_count: MAX_HOP_COUNT + 1 })),
    ).toThrow();
  });
});

describe("RecentlySeen", () => {
  it("seen() is false before mark, true after, false after TTL expires", () => {
    let now = 1000;
    const ttl = 500;
    const rs = new RecentlySeen(ttl, () => now);

    expect(rs.seen("m1")).toBe(false);

    rs.mark("m1");
    expect(rs.seen("m1")).toBe(true);

    now += ttl; // exactly at TTL boundary, still seen
    expect(rs.seen("m1")).toBe(true);

    now += 1; // past TTL
    expect(rs.seen("m1")).toBe(false);
  });
});

describe("tagForeignBot", () => {
  const known = new Set<string>(["known-bot"]);

  it("tags unknown bots as foreign", () => {
    const s = makeSender({ id: "stranger", isBot: true, isForeignBot: false });
    const tagged = tagForeignBot(s, known);
    expect(tagged.isForeignBot).toBe(true);
    expect(tagged).not.toBe(s);
  });

  it("leaves known bots untagged (isForeignBot stays false)", () => {
    const s = makeSender({ id: "known-bot", isBot: true, isForeignBot: false });
    const tagged = tagForeignBot(s, known);
    expect(tagged.isForeignBot).toBe(false);
  });

  it("leaves human senders untouched", () => {
    const s = makeSender({ id: "human", isBot: false, isForeignBot: false });
    const tagged = tagForeignBot(s, known);
    expect(tagged.isForeignBot).toBe(false);
    expect(tagged.isBot).toBe(false);
  });
});

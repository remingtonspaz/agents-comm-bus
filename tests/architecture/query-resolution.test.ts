import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isExpired,
  matchReplyToQuery,
  hasOpenQuery,
  tryResolve,
} from "../../agents-comm-bus-core/src/query-semantics.js";
import type { Query, ResolvedDecision } from "../../agents-comm-bus-core/src/queries.js";
import type {
  AccountId,
  AgentId,
  ChatRef,
  CommId,
  MessageId,
  QueryId,
  SessionId,
} from "../../agents-comm-bus-core/src/types.js";

const CHAT_A: ChatRef = {
  comm: "telegram" as CommId,
  account: "acct1" as AccountId,
  chat_native_id: "1001",
  thread_native_id: undefined,
};

function makeQuery(overrides: Partial<Query> = {}): Query {
  return {
    schema_version: 1,
    query_id: "q1" as QueryId,
    agent: "claude" as AgentId,
    session: "s1" as SessionId,
    kind: "approval",
    origin_chat: CHAT_A,
    source_message_id: "m1" as MessageId,
    prompt_text: "allow?",
    created_at: 1000,
    ttl_seconds: 60,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<ResolvedDecision> = {}): ResolvedDecision {
  return {
    query_id: "q1" as QueryId,
    decision: "allow",
    decided_by_sender_id: "u1",
    decided_in_chat: CHAT_A,
    decided_at: 2000,
    ...overrides,
  };
}

describe("tryResolve", () => {
  it("accepts a fresh, in-chat, unresolved query", () => {
    const result = tryResolve(makeQuery(), makeDecision(), 2000);
    assert.deepEqual(result, { kind: "accepted" });
  });

  it("rejects re-resolution with already_resolved", () => {
    const resolved = makeQuery({ resolution: makeDecision() });
    const result = tryResolve(resolved, makeDecision(), 2000);
    assert.deepEqual(result, { kind: "rejected", reason: "already_resolved" });
  });

  it("rejects expired queries with expired (TTL fail-closed)", () => {
    // created_at=1000, ttl=60s -> expires at 61000
    const result = tryResolve(makeQuery(), makeDecision({ decided_at: 999_999 }), 999_999);
    assert.deepEqual(result, { kind: "rejected", reason: "expired" });
  });

  it("rejects resolution from a different chat_native_id with wrong_chat", () => {
    const decision = makeDecision({
      decided_in_chat: { ...CHAT_A, chat_native_id: "9999" },
    });
    const result = tryResolve(makeQuery(), decision, 2000);
    assert.deepEqual(result, { kind: "rejected", reason: "wrong_chat" });
  });

  it("rejects resolution from a different account even with same chat_native_id", () => {
    const decision = makeDecision({
      decided_in_chat: { ...CHAT_A, account: "acct2" as AccountId },
    });
    const result = tryResolve(makeQuery(), decision, 2000);
    assert.deepEqual(result, { kind: "rejected", reason: "wrong_chat" });
  });
});

describe("matchReplyToQuery", () => {
  it("returns true when chat + reply_to match", () => {
    assert.equal(
      matchReplyToQuery(makeQuery(), CHAT_A, "m1" as MessageId),
      true,
    );
  });

  it("returns false when chat matches but reply_to is a different message", () => {
    assert.equal(
      matchReplyToQuery(makeQuery(), CHAT_A, "m2" as MessageId),
      false,
    );
  });

  it("returns true when query has no source_message_id and chat matches", () => {
    const q = makeQuery({ source_message_id: undefined });
    assert.equal(matchReplyToQuery(q, CHAT_A, undefined), true);
  });
});

describe("hasOpenQuery", () => {
  it("returns true if the session has an entry", () => {
    const map = new Map<string, Query>([["s1", makeQuery()]]);
    assert.equal(hasOpenQuery(map, "s1"), true);
  });

  it("returns false if the session has no entry", () => {
    const map = new Map<string, Query>();
    assert.equal(hasOpenQuery(map, "s1"), false);
  });
});

describe("isExpired", () => {
  it("returns false before TTL elapses", () => {
    assert.equal(isExpired(makeQuery(), 30_000), false);
  });
  it("returns true once TTL elapses", () => {
    assert.equal(isExpired(makeQuery(), 61_000), true);
  });
});

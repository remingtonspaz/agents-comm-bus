import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  matchReplyToQuery,
  tryResolve,
} from "../../packages/core-contracts/src/query-semantics.js";
import type { Query, ResolvedDecision } from "../../packages/core-contracts/src/queries.js";
import type {
  AccountId,
  AgentId,
  ChatRef,
  CommId,
  MessageId,
  QueryId,
  SessionId,
} from "../../packages/core-contracts/src/types.js";

const QUERY_CHAT: ChatRef = {
  comm: "telegram" as CommId,
  account: "primary" as AccountId,
  chat_native_id: "chat-1",
  thread_native_id: "topic-1",
};

const OTHER_CHAT: ChatRef = {
  ...QUERY_CHAT,
  chat_native_id: "chat-2",
};

function makeQuery(overrides: Partial<Query> = {}): Query {
  return {
    schema_version: 1,
    query_id: "query-1" as QueryId,
    agent: "claude" as AgentId,
    session: "session-1" as SessionId,
    kind: "approval",
    origin_chat: QUERY_CHAT,
    source_message_id: "prompt-message-1" as MessageId,
    prompt_text: "allow tool?",
    created_at: 1_000,
    ttl_seconds: 60,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<ResolvedDecision> = {}): ResolvedDecision {
  return {
    query_id: "query-1" as QueryId,
    decision: "allow",
    decided_by_sender_id: "user-1",
    decided_in_chat: QUERY_CHAT,
    decided_at: 2_000,
    ...overrides,
  };
}

describe("stale query responses are rejected", () => {
  it("rejects a reply after the query TTL has expired", () => {
    const result = tryResolve(makeQuery(), makeDecision(), 61_000);

    assert.deepEqual(result, { kind: "rejected", reason: "expired" });
  });

  it("rejects a second response after the query is already resolved", () => {
    const resolved = makeQuery({ resolution: makeDecision() });
    const result = tryResolve(resolved, makeDecision({ decided_at: 3_000 }), 3_000);

    assert.deepEqual(result, { kind: "rejected", reason: "already_resolved" });
  });

  it("rejects a response from a different chat", () => {
    const result = tryResolve(
      makeQuery(),
      makeDecision({ decided_in_chat: OTHER_CHAT }),
      2_000,
    );

    assert.deepEqual(result, { kind: "rejected", reason: "wrong_chat" });
  });

  it("does not match replies to the wrong prompt message", () => {
    assert.equal(
      matchReplyToQuery(
        makeQuery(),
        QUERY_CHAT,
        "different-message" as MessageId,
      ),
      false,
    );
  });
});

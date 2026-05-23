import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clearOwnershipOnDisconnect } from "../../packages/core-contracts/src/query-semantics.js";
import type { Query } from "../../packages/core-contracts/src/queries.js";
import type {
  AccountId,
  AgentId,
  CommId,
  QueryId,
  SessionId,
} from "../../packages/core-contracts/src/types.js";

function makeQuery(id: string): Query {
  return {
    schema_version: 1,
    query_id: id as QueryId,
    agent: "claude" as AgentId,
    session: "s1" as SessionId,
    kind: "approval",
    origin_chat: {
      comm: "telegram" as CommId,
      account: "acct1" as AccountId,
      chat_native_id: "1001",
    },
    prompt_text: "allow?",
    created_at: 1000,
    ttl_seconds: 60,
  };
}

describe("clearOwnershipOnDisconnect", () => {
  it("returns query_ids whose held_by_connection_id matches the closed connection", () => {
    const open = [
      { query: makeQuery("q1"), held_by_connection_id: "conn-A" },
      { query: makeQuery("q2"), held_by_connection_id: "conn-A" },
    ];
    const result = clearOwnershipOnDisconnect("conn-A", open);
    assert.deepEqual(result, ["q1", "q2"]);
  });

  it("returns [] when no queries match", () => {
    const open = [
      { query: makeQuery("q1"), held_by_connection_id: "conn-B" },
    ];
    const result = clearOwnershipOnDisconnect("conn-A", open);
    assert.deepEqual(result, []);
  });

  it("does NOT return query_ids held by other connections", () => {
    const open = [
      { query: makeQuery("q1"), held_by_connection_id: "conn-A" },
      { query: makeQuery("q2"), held_by_connection_id: "conn-B" },
      { query: makeQuery("q3"), held_by_connection_id: "conn-A" },
    ];
    const result = clearOwnershipOnDisconnect("conn-A", open);
    assert.deepEqual(result, ["q1", "q3"]);
  });
});

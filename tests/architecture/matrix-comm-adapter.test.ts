import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MatrixCommAdapter } from "../../adapters/matrix/adapter.js";
import type { CommConnectionState } from "../../packages/core-contracts/src/index.js";

const BOT_MXID = "@agents-comm-bot:matrix.example.org";

describe("MatrixCommAdapter P1 skeleton", () => {
  it("exclusiveResource returns the MXID resource id", () => {
    const adapter = new MatrixCommAdapter({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
      accountId: BOT_MXID as any,
    });
    assert.deepEqual(adapter.exclusiveResource(), { resourceId: BOT_MXID });
  });

  it("allowedSenderIds and updateAllowedSenderIds share backing state", () => {
    const adapter = new MatrixCommAdapter({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
      accountId: BOT_MXID as any,
      allowedUserIds: ["@alice:matrix.example.org"],
    });
    assert.deepEqual(adapter.allowedSenderIds, ["@alice:matrix.example.org"]);
    adapter.updateAllowedSenderIds(["@bob:matrix.example.org"]);
    assert.deepEqual(adapter.allowedSenderIds, ["@bob:matrix.example.org"]);
  });

  it("start and stop emit connection-state transitions and are idempotent enough for rollback", async () => {
    const adapter = new MatrixCommAdapter({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
      accountId: BOT_MXID as any,
    });
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));

    await adapter.start();
    await adapter.start();
    await adapter.stop();
    await adapter.stop();

    assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
  });

  it("send fails loud as unsupported and classifies permanent", async () => {
    const adapter = new MatrixCommAdapter({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
      accountId: BOT_MXID as any,
    });
    try {
      await adapter.send(
        {
          comm: "matrix",
          account: BOT_MXID as any,
          chat_native_id: "!room:matrix.example.org",
        },
        { text: "hello" },
        "idem-1",
      );
      assert.fail("expected send to throw");
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /not implemented/i,
      );
      assert.equal(adapter.classifyFailure(error), "permanent");
    }
  });

  it("classifyFailure covers permanent, rate-limited, and transient examples", () => {
    const adapter = new MatrixCommAdapter({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
      accountId: BOT_MXID as any,
    });

    assert.equal(adapter.classifyFailure({ status: 401, message: "Unauthorized" }), "permanent");
    assert.equal(adapter.classifyFailure({ status: 403, message: "Forbidden" }), "permanent");
    assert.equal(adapter.classifyFailure({ status: 429, message: "Too Many Requests" }), "rate_limited");
    assert.equal(
      adapter.classifyFailure({ errcode: "M_LIMIT_EXCEEDED", message: "M_LIMIT_EXCEEDED" }),
      "rate_limited",
    );
    assert.equal(
      adapter.classifyFailure({ errcode: "M_USER_LIMIT_EXCEEDED", message: "limit" }),
      "rate_limited",
    );
    assert.equal(adapter.classifyFailure({ status: 502, message: "Bad Gateway" }), "transient");
    assert.equal(adapter.classifyFailure(new Error("ECONNRESET")), "transient");
    assert.equal(adapter.classifyFailure(new Error("something else")), "transient");
  });

  it("reportPressure returns zero backlog", () => {
    const adapter = new MatrixCommAdapter({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
      accountId: BOT_MXID as any,
    });
    assert.deepEqual(adapter.reportPressure(), { backlog: 0, rateLimited: false });
  });
});

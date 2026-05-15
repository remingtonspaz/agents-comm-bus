import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TelegramCommAdapter } from "../../agents-comm-bus/src/adapters/comm/telegram.js";

describe("TelegramCommAdapter failure classification", () => {
  it("classifies 403 blocked/kicked paths as permanent", () => {
    const adapter = new TelegramCommAdapter({ botToken: "test", polling: false });

    assert.equal(
      adapter.classifyFailure({ response: { statusCode: 403 }, message: "Forbidden" }),
      "permanent",
    );
    assert.equal(adapter.classifyFailure(new Error("bot was blocked by the user")), "permanent");
  });

  it("classifies rate limits separately from transient failures", () => {
    const adapter = new TelegramCommAdapter({ botToken: "test", polling: false });

    assert.equal(
      adapter.classifyFailure({ response: { statusCode: 429 }, message: "Too Many Requests" }),
      "rate_limited",
    );
    assert.equal(adapter.classifyFailure(new Error("ECONNRESET")), "transient");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type TelegramBot from "node-telegram-bot-api";

import { TelegramCommAdapter } from "../../agents-comm-bus/src/adapters/comm/telegram.js";
import type { CommConnectionState } from "../../agents-comm-bus-core/src/index.js";

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

  it("recovers degraded connection state after successful Telegram activity", async () => {
    const bot = new FakeTelegramBot();
    const adapter = new TelegramCommAdapter({
      botToken: "test",
      bot: bot as unknown as TelegramBot,
      allowedUserIds: ["42"],
    });
    const states: CommConnectionState[] = [];

    adapter.onConnectionState((state) => states.push(state));
    adapter.onInbound(async () => {});

    await adapter.start();
    bot.emitPollingError(new Error("409 conflict"));
    await bot.emitMessage({
      message_id: 7,
      chat: { id: 99 },
      from: { id: 42, username: "tester", is_bot: false },
      text: "hello",
    });

    assert.deepEqual(states, ["connecting", "connected", "degraded", "connected"]);
  });
});

class FakeTelegramBot {
  private messageHandler: ((message: TelegramBot.Message) => void) | null = null;
  private pollingErrorHandler: ((error: Error) => void) | null = null;

  async getMe(): Promise<TelegramBot.User> {
    return { id: 100, username: "test_bot" };
  }

  on(event: "message" | "polling_error", handler: ((message: TelegramBot.Message) => void) | ((error: Error) => void)): void {
    if (event === "message") {
      this.messageHandler = handler as (message: TelegramBot.Message) => void;
    } else {
      this.pollingErrorHandler = handler as (error: Error) => void;
    }
  }

  isPolling(): boolean {
    return false;
  }

  async stopPolling(): Promise<void> {}

  async sendMessage(): Promise<TelegramBot.Message> {
    return { message_id: 1, chat: { id: 99 } };
  }

  async sendDocument(): Promise<TelegramBot.Message> {
    return { message_id: 1, chat: { id: 99 } };
  }

  emitPollingError(error: Error): void {
    this.pollingErrorHandler?.(error);
  }

  async emitMessage(message: TelegramBot.Message): Promise<void> {
    this.messageHandler?.(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

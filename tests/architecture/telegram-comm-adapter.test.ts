import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type TelegramBot from "node-telegram-bot-api";

import { TelegramCommAdapter, pollingConflictMessage } from "../../adapters/telegram/adapter.js";
import type { CommConnectionState } from "../../packages/core-contracts/src/index.js";
import type { BlobRef, BlobStore } from "../../packages/core-contracts/src/storage/blob-store.js";

describe("AGE-35 Telegram 409 polling-conflict diagnostic", () => {
  it("returns a loud, actionable message for a 409 Conflict polling error", () => {
    const msg = pollingConflictMessage(
      new Error("ETELEGRAM: 409 Conflict: terminated by other getUpdates request"),
      "8950482517",
      "8950482517",
    );
    assert.ok(msg, "a 409 polling error must produce a loud message");
    assert.match(msg!, /409 Conflict/);
    assert.match(msg!, /8950482517/); // bot / resource id surfaced
    assert.match(msg!, /stray daemon|external poller/);
  });

  it("falls back to the accountId when botUserId is not yet known", () => {
    const msg = pollingConflictMessage(new Error("409 Conflict"), "acct-77", null);
    assert.ok(msg);
    assert.match(msg!, /bot acct-77/);
  });

  it("returns null for non-409 polling errors (no false loud log)", () => {
    assert.equal(pollingConflictMessage(new Error("ETELEGRAM: 502 Bad Gateway"), "1", "1"), null);
    assert.equal(pollingConflictMessage(new Error("ECONNRESET"), "1", "1"), null);
    // a "409" embedded in a longer number must NOT trip the word-boundary match
    assert.equal(pollingConflictMessage(new Error("status 4090 elsewhere"), "1", "1"), null);
  });

  it("the adapter wires the loud log on a 409 polling_error (injected bot + logger)", async () => {
    const logged: string[] = [];
    const handlers: Record<string, (arg: unknown) => void> = {};
    const fakeBot = {
      getMe: async () => ({ id: 555 }),
      on: (event: string, handler: (arg: unknown) => void) => {
        handlers[event] = handler;
      },
      isPolling: () => false,
      stopPolling: async () => {},
    } as unknown as TelegramBot;

    const adapter = new TelegramCommAdapter({
      botToken: "test",
      accountId: "555" as any,
      bot: fakeBot,
      polling: false,
      log: (m) => logged.push(m),
    });
    await adapter.start();
    handlers["polling_error"]?.(new Error("ETELEGRAM: 409 Conflict: terminated by other getUpdates request"));
    assert.equal(logged.length, 1, "a 409 polling_error must emit exactly one loud log");
    assert.match(logged[0], /409 Conflict/);

    logged.length = 0;
    handlers["polling_error"]?.(new Error("ETELEGRAM: 502 Bad Gateway"));
    assert.equal(logged.length, 0, "a non-409 polling_error must not emit the loud 409 log");
  });
});

describe("TelegramCommAdapter failure classification", () => {
  it("classifies 403 blocked/kicked paths as permanent", () => {
    const adapter = new TelegramCommAdapter({ botToken: "test", accountId: "100" as any, polling: false });

    assert.equal(
      adapter.classifyFailure({ response: { statusCode: 403 }, message: "Forbidden" }),
      "permanent",
    );
    assert.equal(adapter.classifyFailure(new Error("bot was blocked by the user")), "permanent");
  });

  it("classifies rate limits separately from transient failures", () => {
    const adapter = new TelegramCommAdapter({ botToken: "test", accountId: "100" as any, polling: false });

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
      accountId: "100" as any,
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

  it("retrieves inbound photo attachments into the blob store", async () => {
    const bot = new FakeTelegramBot();
    const blobs = new FakeBlobStore();
    const adapter = new TelegramCommAdapter({
      botToken: "test",
      accountId: "100" as any,
      bot: bot as unknown as TelegramBot,
      allowedUserIds: ["42"],
      attachmentBlobStore: blobs,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(`bytes from ${url}`).buffer,
      } as Response),
    });
    const received: unknown[] = [];

    adapter.onInbound(async (message) => {
      received.push(message);
    });
    await adapter.start();
    await bot.emitMessage({
      message_id: 8,
      chat: { id: 99 },
      from: { id: 42, username: "tester", is_bot: false },
      caption: "what do you see?",
      photo: [
        { file_id: "small-photo", file_unique_id: "small", width: 16, height: 16, file_size: 5 },
        { file_id: "large-photo", file_unique_id: "large", width: 1024, height: 768, file_size: 123 },
      ],
    } as TelegramBot.Message);

    const message = received[0] as { attachments?: Array<Record<string, unknown>> };
    assert.equal(message.attachments?.length, 1);
    assert.equal(message.attachments?.[0]?.filename, "large-photo.jpg");
    assert.equal(message.attachments?.[0]?.blob_hash, "hash-1");
    assert.equal(message.attachments?.[0]?.local_path, "D:\\tmp\\hash-1");
    assert.equal(blobs.contents[0], "bytes from https://telegram.test/large-photo");
  });
});

class FakeTelegramBot {
  private messageHandler: ((message: TelegramBot.Message) => void) | null = null;
  private callbackHandler: ((query: TelegramBot.CallbackQuery) => void) | null = null;
  private pollingErrorHandler: ((error: Error) => void) | null = null;

  async getMe(): Promise<TelegramBot.User> {
    return { id: 100, username: "test_bot" };
  }

  on(
    event: "message" | "callback_query" | "polling_error",
    handler:
      | ((message: TelegramBot.Message) => void)
      | ((query: TelegramBot.CallbackQuery) => void)
      | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.messageHandler = handler as (message: TelegramBot.Message) => void;
    } else if (event === "callback_query") {
      this.callbackHandler = handler as (query: TelegramBot.CallbackQuery) => void;
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

  async getFileLink(fileId: string): Promise<string> {
    return `https://telegram.test/${fileId}`;
  }

  emitPollingError(error: Error): void {
    this.pollingErrorHandler?.(error);
  }

  async emitMessage(message: TelegramBot.Message): Promise<void> {
    this.messageHandler?.(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class FakeBlobStore implements BlobStore {
  readonly contents: string[] = [];

  async put(content: Uint8Array, mime?: string): Promise<BlobRef> {
    void mime;
    this.contents.push(new TextDecoder().decode(content));
    return { hash: `hash-${this.contents.length}`, size: content.byteLength, mime };
  }

  async open(_ref: BlobRef): Promise<ReadableStream<Uint8Array>> {
    throw new Error("not implemented");
  }

  pathFor(ref: BlobRef): string {
    return `D:\\tmp\\${ref.hash}`;
  }

  async exists(_ref: BlobRef): Promise<boolean> {
    return true;
  }
}

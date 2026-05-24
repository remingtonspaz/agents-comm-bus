import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type TelegramBot from "node-telegram-bot-api";

import { TelegramCommAdapter } from "../../adapters/telegram/adapter.js";
import type { CommConnectionState } from "../../packages/core-contracts/src/index.js";
import type { BlobRef, BlobStore } from "../../packages/core-contracts/src/storage/blob-store.js";

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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIMessage,
  type GatewayDispatchPayload,
} from "discord-api-types/v10";

import { DiscordCommAdapter } from "../../adapters/discord/adapter.js";
import { DISCORD_GATEWAY_INTENTS, type DiscordGatewayLike } from "../../adapters/discord/gateway.js";
import { buildMessageFromDiscordCreate } from "../../adapters/discord/normalize.js";
import type { CommConnectionState, CommId, FilterDropEvent, Message } from "../../packages/core-contracts/src/index.js";

const DISCORD = "discord" as CommId;
const BOT_ID = "123456789012345678";

describe("Discord gateway intents", () => {
  it("uses GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT", () => {
    const expected =
      GatewayIntentBits.Guilds |
      GatewayIntentBits.GuildMessages |
      GatewayIntentBits.DirectMessages |
      GatewayIntentBits.MessageContent;
    assert.equal(DISCORD_GATEWAY_INTENTS, expected);
    assert.equal(DISCORD_GATEWAY_INTENTS, 37377);
  });
});

describe("Discord gateway connection-state mapping", () => {
  it("maps lifecycle events to connection states", async () => {
    const gateway = new FakeDiscordGateway();
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: BOT_ID as never,
      rest: makeFakeRest(),
      gateway,
    });
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));
    await adapter.start();

    gateway.emitConnectionState("degraded");
    gateway.emitConnectionState("connected");
    gateway.emitConnectionState("disconnected");

    assert.deepEqual(states, ["connecting", "connected", "degraded", "connected", "disconnected"]);
    await adapter.stop();
  });
});

describe("Discord MESSAGE_CREATE normalization", () => {
  const baseContext = {
    commId: DISCORD,
    botUserId: BOT_ID,
    accountId: BOT_ID as never,
    now: () => 1_700_000_000_000,
  };

  it("maps plain text messages", () => {
    const message = buildMessageFromDiscordCreate(
      discordMessage({ id: "42", channel_id: "chan-1", content: "hello" }),
      baseContext,
    );
    assert.ok(message);
    assert.equal(message!.message_id, "discord:42");
    assert.equal(message!.chat.chat_native_id, "chan-1");
    assert.equal(message!.chat.thread_native_id, undefined);
    assert.equal(message!.text, "hello");
    assert.equal(message!.platform_message_id, "42");
    assert.equal(message!.sender.id, "user-1");
    assert.equal(message!.sender.display_name, "Tester");
    assert.equal(message!.hop_count, 0);
    assert.equal(message!.origin.comm, "discord");
  });

  it("maps reply_to with discord: prefix", () => {
    const message = buildMessageFromDiscordCreate(
      discordMessage({
        id: "43",
        channel_id: "chan-1",
        content: "reply",
        message_reference: { message_id: "99", channel_id: "chan-1" },
      }),
      baseContext,
    );
    assert.equal(message!.reply_to, "discord:99");
  });

  it("maps thread channels with parent id as chat_native_id", () => {
    const message = buildMessageFromDiscordCreate(
      discordMessage({ id: "44", channel_id: "thread-9", content: "in thread" }),
      { ...baseContext, threadParentChannelId: "parent-chan" },
    );
    assert.equal(message!.chat.chat_native_id, "parent-chan");
    assert.equal(message!.chat.thread_native_id, "thread-9");
  });

  it("maps attachment metadata without downloading", () => {
    const message = buildMessageFromDiscordCreate(
      discordMessage({
        id: "45",
        channel_id: "chan-1",
        content: "see file",
        attachments: [{
          id: "att-1",
          filename: "note.txt",
          size: 12,
          url: "https://cdn.discordapp.com/attachments/1/note.txt",
          proxy_url: "https://media.discordapp.net/attachments/1/note.txt",
          content_type: "text/plain",
        }],
      }),
      baseContext,
    );
    assert.equal(message!.attachments?.length, 1);
    assert.equal(message!.attachments?.[0]?.filename, "note.txt");
    assert.equal(message!.attachments?.[0]?.platform_metadata?.url,
      "https://cdn.discordapp.com/attachments/1/note.txt");
  });

  it("returns null when there is no text and no attachments", () => {
    const message = buildMessageFromDiscordCreate(
      discordMessage({ id: "46", channel_id: "chan-1", content: "" }),
      baseContext,
    );
    assert.equal(message, null);
  });
});

describe("Discord inbound filtering (telegram parity)", () => {
  it("drops allowlisted senders with sender_not_allowed", async () => {
    const gateway = new FakeDiscordGateway();
    const drops: FilterDropEvent[] = [];
    const received: Message[] = [];
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: BOT_ID as never,
      allowedUserIds: ["allowed-user"],
      rest: makeFakeRest(),
      gateway,
    });
    adapter.onFilterDrop((event) => drops.push(event));
    adapter.onInbound(async (message) => {
      received.push(message);
    });
    await adapter.start();

    await gateway.emitMessageCreate(
      discordMessage({ id: "50", channel_id: "chan-1", content: "blocked", author: { id: "other", username: "x" } }),
    );

    assert.equal(received.length, 0);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.reason, "sender_not_allowed");
    assert.equal(drops[0]!.update_kind, "message");
    await adapter.stop();
  });

  it("drops missing author id with missing_sender_id", async () => {
    const gateway = new FakeDiscordGateway();
    const drops: FilterDropEvent[] = [];
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: BOT_ID as never,
      allowedUserIds: ["allowed-user"],
      rest: makeFakeRest(),
      gateway,
    });
    adapter.onFilterDrop((event) => drops.push(event));
    adapter.onInbound(async () => {});
    await adapter.start();

    await gateway.emitMessageCreate(
      discordMessage({ id: "51", channel_id: "chan-1", content: "ghost", author: undefined }),
    );

    assert.equal(drops[0]!.reason, "missing_sender_id");
    await adapter.stop();
  });

  it("delivers own-bot messages with isForeignBot false (bus handles loop prevention)", async () => {
    const gateway = new FakeDiscordGateway();
    const received: Message[] = [];
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: BOT_ID as never,
      rest: makeFakeRest(),
      gateway,
    });
    adapter.onInbound(async (message) => {
      received.push(message);
    });
    await adapter.start();

    await gateway.emitMessageCreate(
      discordMessage({
        id: "52",
        channel_id: "chan-1",
        content: "echo",
        author: { id: BOT_ID, username: "self-bot", bot: true },
      }),
    );

    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender.isBot, true);
    assert.equal(received[0]!.sender.isForeignBot, false);
    await adapter.stop();
  });

  it("flags foreign bots and delivers to inbound (bus foreign-bot gate decides)", async () => {
    const gateway = new FakeDiscordGateway();
    const received: Message[] = [];
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: BOT_ID as never,
      rest: makeFakeRest(),
      gateway,
    });
    adapter.onInbound(async (message) => {
      received.push(message);
    });
    await adapter.start();

    await gateway.emitMessageCreate(
      discordMessage({
        id: "53",
        channel_id: "chan-1",
        content: "other bot",
        author: { id: "999999999999999999", username: "other-bot", bot: true },
      }),
    );

    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender.isBot, true);
    assert.equal(received[0]!.sender.isForeignBot, true);
    await adapter.stop();
  });

  it("stop() destroys the gateway without leaving open handles", async () => {
    const gateway = new FakeDiscordGateway();
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: BOT_ID as never,
      rest: makeFakeRest(),
      gateway,
    });
    adapter.onInbound(async () => {});
    await adapter.start();
    assert.equal(gateway.destroyed, false);
    await adapter.stop();
    assert.equal(gateway.destroyed, true);
    assert.equal(gateway.dispatchHandler, null);
  });
});

function discordMessage(
  overrides: Partial<APIMessage> & Pick<APIMessage, "id" | "channel_id">,
): APIMessage {
  const author = "author" in overrides
    ? overrides.author
    : {
        id: "user-1",
        username: "tester",
        global_name: "Tester",
        discriminator: "0",
      };
  return {
    id: overrides.id,
    channel_id: overrides.channel_id,
    content: overrides.content ?? "hello",
    author,
    attachments: overrides.attachments ?? [],
    message_reference: overrides.message_reference,
    timestamp: "2026-06-06T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    pinned: false,
    type: 0,
  } as APIMessage;
}

function makeFakeRest() {
  return {
    setToken() {
      return this;
    },
    destroy() {},
    get: async () => ({ id: BOT_ID }),
    post: async () => ({ id: "1" }),
  };
}

class FakeDiscordGateway implements DiscordGatewayLike {
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  dispatchHandler: ((payload: GatewayDispatchPayload) => void) | null = null;
  destroyed = false;
  private readonly threadParents = new Map<string, string>();

  onDispatch(handler: (payload: GatewayDispatchPayload) => void): void {
    this.dispatchHandler = handler;
  }

  onConnectionState(handler: (state: CommConnectionState) => void): void {
    this.stateHandler = handler;
  }

  threadParentChannelId(channelId: string): string | undefined {
    return this.threadParents.get(channelId);
  }

  async connect(): Promise<void> {
    this.stateHandler?.("connected");
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.dispatchHandler = null;
    this.stateHandler = null;
    this.threadParents.clear();
  }

  emitConnectionState(state: CommConnectionState): void {
    this.stateHandler?.(state);
  }

  async emitMessageCreate(raw: APIMessage, options?: { threadParentChannelId?: string }): Promise<void> {
    if (options?.threadParentChannelId) {
      this.threadParents.set(String(raw.channel_id), options.threadParentChannelId);
    }
    this.dispatchHandler?.({
      t: GatewayDispatchEvents.MessageCreate,
      s: 1,
      op: 0,
      d: raw,
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
}

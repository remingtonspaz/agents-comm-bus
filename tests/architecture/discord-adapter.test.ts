import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimitError } from "@discordjs/rest";

import {
  DiscordCommAdapter,
  discordMessageBody,
  uploadFilenameFromLocalPath,
  type DiscordRestLike,
} from "../../adapters/discord/adapter.js";
import { htmlToDiscordMarkdown } from "../../adapters/discord/html.js";
import { discordNonceFromIdempotencyKey } from "../../adapters/discord/nonce.js";
import type { DiscordGatewayLike } from "../../adapters/discord/gateway.js";
import { GatewayDispatchEvents, type APIMessage, type GatewayDispatchPayload } from "discord-api-types/v10";
import type { BlobRef, BlobStore, Message } from "../../packages/core-contracts/src/index.js";
import type { CommConnectionState } from "../../packages/core-contracts/src/index.js";
import { DiscordCommAdapterFactory } from "../../adapters/discord/factory.js";
import { writeTokenFile } from "../../core-daemon/cli/token-file.js";
import type { SendRequest } from "../../core-daemon/bus.js";
import type {
  AccountRegistration,
  AgentId,
  CommId,
  Session,
  SessionId,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/index.js";

const DISCORD = "discord" as CommId;
const CLAUDE = "claude" as AgentId;

function makeRegistration(overrides: Partial<AccountRegistration> = {}): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: "/tmp/project-discord-test",
    comm: DISCORD,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: "123456789012345678",
    credentials_ref: "file:/missing/discord.json",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

async function writeCredentialFile(
  dir: string,
  body: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, "discord.json");
  await writeFile(path, JSON.stringify(body));
  return `file:${path}`;
}

describe("DiscordCommAdapterFactory contract", () => {
  it("exposes commId discord", () => {
    const factory = new DiscordCommAdapterFactory();
    assert.equal(factory.commId, "discord");
  });

  it("resolves credentials from a writeTokenFile-shaped daemon-owned file ref", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-cred-"));
    const factory = new DiscordCommAdapterFactory();
    const credentialsRef = await writeTokenFile({
      stateRoot: dir,
      comm: DISCORD,
      project: "/tmp/project-discord-test",
      agent: CLAUDE,
      accountId: "123456789012345678",
      botToken: "test-token",
    });
    const resolved = await factory.resolveCredentials(
      makeRegistration({ credentials_ref: credentialsRef }),
      {},
    );
    assert.deepEqual(resolved?.credentials, {
      botToken: "test-token",
      allowedUserIds: [],
    });
  });

  it("merges userId from the token file with env allowlist entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-cred-allowlist-"));
    const factory = new DiscordCommAdapterFactory();
    const credentialsRef = await writeTokenFile({
      stateRoot: dir,
      comm: DISCORD,
      project: "/tmp/project-discord-test",
      agent: CLAUDE,
      accountId: "123456789012345678",
      botToken: "test-token",
      userId: ["123"],
    });
    const resolved = await factory.resolveCredentials(
      makeRegistration({ credentials_ref: credentialsRef }),
      { DISCORD_USER_ID: "env-sender-1,env-sender-2" },
    );
    assert.deepEqual(resolved?.credentials.botToken, "test-token");
    assert.deepEqual(
      [...(resolved?.credentials.allowedUserIds as string[])].sort(),
      ["123", "env-sender-1", "env-sender-2"].sort(),
    );
  });

  it("accepts bot_token as a tolerated alias in hand-written credential files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-cred-alias-"));
    const factory = new DiscordCommAdapterFactory();
    const resolved = await factory.resolveCredentials(
      makeRegistration({
        credentials_ref: await writeCredentialFile(dir, { bot_token: "alias-token" }),
      }),
      {},
    );
    assert.deepEqual(resolved?.credentials, {
      botToken: "alias-token",
      allowedUserIds: [],
    });
  });

  it("returns undefined when the credentials file is missing", async () => {
    const factory = new DiscordCommAdapterFactory();
    const resolved = await factory.resolveCredentials(
      makeRegistration({ credentials_ref: "file:/no/such/discord.json" }),
      {},
    );
    assert.equal(resolved, undefined);
  });

  it("returns undefined when the credentials file contains malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-bad-json-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{not-json");
    const factory = new DiscordCommAdapterFactory();
    const resolved = await factory.resolveCredentials(
      makeRegistration({ credentials_ref: `file:${path}` }),
      {},
    );
    assert.equal(resolved, undefined);
  });

  it("create() wires exclusiveResource to the bot user id", () => {
    const factory = new DiscordCommAdapterFactory();
    const adapter = factory.create(
      { botToken: "test-token" },
      "123456789012345678" as never,
    );
    assert.deepEqual(adapter.exclusiveResource?.(), { resourceId: "123456789012345678" });
  });
});

describe("DiscordCommAdapter REST send", () => {
  it("posts channel messages with content and allowed_mentions disabled", async () => {
    const posts: Array<{ route: string; body: Record<string, unknown> }> = [];
    const rest = makeFakeRest({
      post: async (route, { body }) => {
        posts.push({ route, body });
        return { id: "999" };
      },
    });
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest,
      gateway: new NoopDiscordGateway(),
    });
    await adapter.start();

    const result = await adapter.send(
      {
        comm: DISCORD,
        account: "123456789012345678" as never,
        chat_native_id: "chan-1",
      },
      { text: "hello discord" },
      "idem-1",
    );

    assert.equal(result.platform_message_id, "999");
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.route, /channels\/chan-1\/messages/);
    assert.equal(posts[0]!.body.content, "hello discord");
    assert.deepEqual(posts[0]!.body.allowed_mentions, { parse: [] });
  });

  it("discordMessageBody always includes allowed_mentions.parse = []", () => {
    const body = discordMessageBody({ text: "ping" });
    assert.deepEqual(body.allowed_mentions, { parse: [] });
  });

  it("retries a 429 once after retry_after", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const rest = makeFakeRest({
      post: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RateLimitError({
            timeToReset: Date.now() + 250,
            limit: 5,
            method: "POST",
            hash: "hash",
            url: "https://discord.com/api/v10/channels/chan-1/messages",
            route: "/channels/:id/messages",
            majorParameter: "chan-1",
            global: false,
            retryAfter: 0.25,
            scope: "user",
          });
        }
        return { id: "1001" };
      },
    });
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest,
      gateway: new NoopDiscordGateway(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await adapter.start();

    const result = await adapter.send(
      {
        comm: DISCORD,
        account: "123456789012345678" as never,
        chat_native_id: "chan-1",
      },
      { text: "retry me" },
      "idem-429",
    );

    assert.equal(result.platform_message_id, "1001");
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [250]);
  });

  it("dedupes sends by idempotency key", async () => {
    let posts = 0;
    const rest = makeFakeRest({
      post: async () => {
        posts += 1;
        return { id: "42" };
      },
    });
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest,
      gateway: new NoopDiscordGateway(),
    });
    await adapter.start();

    const target = {
      comm: DISCORD,
      account: "123456789012345678" as never,
      chat_native_id: "chan-1",
    };
    await adapter.send(target, { text: "once" }, "same-key");
    await adapter.send(target, { text: "once" }, "same-key");
    assert.equal(posts, 1);
  });
});

describe("DiscordCommAdapter failure classification", () => {
  it("maps auth/forbidden, rate limits, and transient failures", () => {
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
    });

    assert.equal(adapter.classifyFailure({ status: 401, message: "Unauthorized" }), "permanent");
    assert.equal(adapter.classifyFailure({ status: 403, message: "Forbidden" }), "permanent");
    assert.equal(adapter.classifyFailure({ status: 429, message: "Too Many Requests" }), "rate_limited");
    assert.equal(adapter.classifyFailure({ status: 503, message: "Service Unavailable" }), "transient");
    assert.equal(adapter.classifyFailure(new Error("ECONNRESET")), "transient");
  });
});

describe("discord_send IPC handler", () => {
  it("routes through bus.send with an explicit bot id target", async () => {
    const storage = new TargetStorage([
      makeRegistration({
        project: "D:\\repo",
        bot_user_id: "123456789012345678",
      }),
    ], {
      session_id: "discord_session" as SessionId,
      agent: CLAUDE,
      project: "D:\\repo",
      schema_version: 1,
      created_at: 1,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
lease_owner_daemon_discovery_root: null,
lease_owner_daemon_checkout_root: null,
lease_owner_daemon_state_root: null,
lease_owner_daemon_bin: null,
lease_owner_daemon_authority_rank: null,
      most_recent_inbound_conversation_id: null,
      status: "active",
    });
    const bus = new RecordingBus();
    const factory = new DiscordCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: storage as never,
      pendingInbound: [],
    } as never).get("discord_send");

    assert.ok(handler);
    await handler({
      session: "discord_session",
      message: "probe",
      target: {
        account: "123456789012345678",
        chat_native_id: "chan-77",
      },
    });

    assert.equal(bus.lastSend?.comm, "discord");
    assert.equal(bus.lastSend?.target?.account, "123456789012345678");
    assert.equal(bus.lastSend?.target?.chat_native_id, "chan-77");
    assert.equal(bus.lastSend?.payload?.text, "probe");
  });

  it("discord_send_image routes attachment payloads through bus.send", async () => {
    const bus = new RecordingBus();
    const factory = new DiscordCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: new TargetStorage([], {
        session_id: "discord_session" as SessionId,
        agent: CLAUDE,
        project: "D:\\repo",
        schema_version: 1,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
lease_owner_daemon_discovery_root: null,
lease_owner_daemon_checkout_root: null,
lease_owner_daemon_state_root: null,
lease_owner_daemon_bin: null,
lease_owner_daemon_authority_rank: null,
        most_recent_inbound_conversation_id: null,
        status: "active",
      }) as never,
      pendingInbound: [],
    } as never).get("discord_send_image");

    assert.ok(handler);
    await handler({
      session: "discord_session",
      path: "D:\\tmp\\diagram.png",
      caption: "see attached",
      target: {
        account: "123456789012345678",
        chat_native_id: "chan-77",
      },
    });

    assert.equal(bus.lastSend?.payload?.attachments?.[0]?.local_path, "D:\\tmp\\diagram.png");
    assert.equal(bus.lastSend?.payload?.attachments?.[0]?.filename, "diagram.png");
    assert.equal(bus.lastSend?.payload?.text, "see attached");
  });

  it("rejects account labels before bus.send", async () => {
    const bus = new RecordingBus();
    const factory = new DiscordCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: new TargetStorage([], {
        session_id: "discord_session" as SessionId,
        agent: CLAUDE,
        project: "D:\\repo",
        schema_version: 1,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
lease_owner_daemon_discovery_root: null,
lease_owner_daemon_checkout_root: null,
lease_owner_daemon_state_root: null,
lease_owner_daemon_bin: null,
lease_owner_daemon_authority_rank: null,
        most_recent_inbound_conversation_id: null,
        status: "active",
      }) as never,
      pendingInbound: [],
    } as never).get("discord_send");

    assert.ok(handler);
    await assert.rejects(
      () =>
        handler({
          session: "discord_session",
          message: "nope",
          target: {
            account: "main",
            chat_native_id: "chan-77",
          },
        }),
      /not a registered bot id/i,
    );
    assert.equal(bus.lastSend, null);
  });
});

describe("Discord html → markdown conversion", () => {
  const cases: Array<[string, string]> = [
    ["<b>bold</b>", "**bold**"],
    ["<strong>strong</strong>", "**strong**"],
    ["<i>italic</i>", "*italic*"],
    ["<em>emphasis</em>", "*emphasis*"],
    ["<code>inline</code>", "`inline`"],
    ["<pre>block</pre>", "```\nblock\n```"],
    ['<a href="https://example.com">link</a>', "link (https://example.com)"],
    ["plain &amp; &lt;tag&gt;", "plain & <tag>"],
  ];

  for (const [input, expected] of cases) {
    it(`converts ${input}`, () => {
      assert.equal(htmlToDiscordMarkdown(input), expected);
    });
  }

  it("discordMessageBody converts html payloads", () => {
    const body = discordMessageBody({ text: "<b>Allow?</b>", format: "html" });
    assert.equal(body.content, "**Allow?**");
    assert.deepEqual(body.allowed_mentions, { parse: [] });
  });
});

describe("Discord send nonce mapping", () => {
  it("maps idempotency keys to stable nonces of at most 25 chars", () => {
    const key = "query:q_test-123";
    const nonce = discordNonceFromIdempotencyKey(key);
    assert.equal(nonce, discordNonceFromIdempotencyKey(key));
    assert.ok(nonce.length <= 25);
  });

  it("includes enforce_nonce on outbound bodies", () => {
    const body = discordMessageBody({ text: "hi" }, "idem-key-1");
    assert.equal(body.nonce, discordNonceFromIdempotencyKey("idem-key-1"));
    assert.equal(body.enforce_nonce, true);
  });
});

describe("DiscordCommAdapter outbound attachments", () => {
  it("uploadFilenameFromLocalPath strips Windows-style paths to basename only", () => {
    assert.equal(uploadFilenameFromLocalPath("D:\\tmp\\diagram.png"), "diagram.png");
    assert.equal(uploadFilenameFromLocalPath("D:/tmp/mixed/shot.png"), "shot.png");
  });

  it("multipart upload uses basename only, not the full caller local path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-basename-"));
    const filePath = join(dir, "diagram.png");
    await writeFile(filePath, "png bytes");

    const posts: Array<{ files?: Array<{ name: string }> }> = [];
    const rest = makeFakeRest({
      post: async (_route, { files }) => {
        posts.push({ files: files?.map((file) => ({ name: file.name })) });
        return { id: "basename-1" };
      },
    });
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest,
      gateway: new NoopDiscordGateway(),
    });
    await adapter.start();

    await adapter.send(
      {
        comm: DISCORD,
        account: "123456789012345678" as never,
        chat_native_id: "chan-1",
      },
      {
        attachments: [
          {
            filename: uploadFilenameFromLocalPath("D:\\tmp\\diagram.png"),
            local_path: filePath,
            mime: "image/png",
            size: 8,
          },
        ],
      },
      "basename-idem",
    );

    assert.equal(posts[0]!.files?.[0]?.name, "diagram.png");
    assert.doesNotMatch(String(posts[0]!.files?.[0]?.name), /[\\/]/);
    assert.notEqual(posts[0]!.files?.[0]?.name, filePath);
  });

  it("derives multipart basename from local_path when filename is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-derived-basename-"));
    const filePath = join(dir, "shot.png");
    await writeFile(filePath, "png bytes");

    const posts: Array<{ files?: Array<{ name: string }> }> = [];
    const rest = makeFakeRest({
      post: async (_route, { files }) => {
        posts.push({ files: files?.map((file) => ({ name: file.name })) });
        return { id: "derived-1" };
      },
    });
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest,
      gateway: new NoopDiscordGateway(),
    });
    await adapter.start();

    await adapter.send(
      {
        comm: DISCORD,
        account: "123456789012345678" as never,
        chat_native_id: "chan-1",
      },
      {
        attachments: [
          {
            local_path: filePath,
            mime: "image/png",
            size: 8,
          },
        ],
      },
      "derived-idem",
    );

    assert.equal(posts[0]!.files?.[0]?.name, "shot.png");
    assert.doesNotMatch(String(posts[0]!.files?.[0]?.name), /[\\/]/);
  });

  it("uploads attachments via multipart while keeping allowed_mentions disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-out-attach-"));
    const filePath = join(dir, "report.txt");
    await writeFile(filePath, "attachment bytes");

    const posts: Array<{ body: Record<string, unknown>; files?: Array<{ name: string; data: Buffer }> }> = [];
    const rest = makeFakeRest({
      post: async (_route, { body, files }) => {
        posts.push({
          body,
          files: files?.map((file) => ({ name: file.name, data: Buffer.from(file.data as Buffer) })),
        });
        return { id: "attach-1" };
      },
    });
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest,
      gateway: new NoopDiscordGateway(),
    });
    await adapter.start();

    await adapter.send(
      {
        comm: DISCORD,
        account: "123456789012345678" as never,
        chat_native_id: "chan-1",
      },
      {
        text: "see file",
        attachments: [
          {
            filename: "report.txt",
            local_path: filePath,
            mime: "text/plain",
            size: 16,
          },
        ],
      },
      "attach-idem",
    );

    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]!.body.allowed_mentions, { parse: [] });
    assert.equal(posts[0]!.body.content, "see file");
    assert.equal(posts[0]!.files?.[0]?.name, "report.txt");
    assert.equal(posts[0]!.files?.[0]?.data.toString(), "attachment bytes");
  });
});

describe("DiscordCommAdapter inbound attachments", () => {
  it("retrieves inbound attachments into the blob store at receipt", async () => {
    const gateway = new InboundTestGateway();
    const blobs = new FakeBlobStore();
    const received: Message[] = [];
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest: makeFakeRest(),
      gateway,
      attachmentBlobStore: blobs,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(`bytes from ${url}`).buffer,
      } as Response),
    });
    adapter.onInbound(async (message) => {
      received.push(message);
    });
    await adapter.start();

    await gateway.emitMessageCreate({
      id: "55",
      channel_id: "chan-1",
      content: "screenshot",
      attachments: [
        {
          id: "att-1",
          filename: "shot.png",
          content_type: "image/png",
          size: 42,
          url: "https://cdn.discordapp.com/attachments/1/shot.png",
          proxy_url: "https://cdn.discordapp.com/attachments/1/shot.png",
        },
      ],
    } as APIMessage);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.attachments?.length, 1);
    assert.equal(received[0]!.attachments?.[0]?.blob_hash, "hash-1");
    assert.equal(received[0]!.attachments?.[0]?.local_path, "D:\\tmp\\hash-1");
    assert.equal(blobs.contents[0], "bytes from https://cdn.discordapp.com/attachments/1/shot.png");
  });

  it("delivers metadata-only attachments when CDN download fails", async () => {
    const gateway = new InboundTestGateway();
    const blobs = new FakeBlobStore();
    const received: Message[] = [];
    const adapter = new DiscordCommAdapter({
      botToken: "test",
      accountId: "123456789012345678" as never,
      rest: makeFakeRest(),
      gateway,
      attachmentBlobStore: blobs,
      fetch: async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response),
    });
    adapter.onInbound(async (message) => {
      received.push(message);
    });
    await adapter.start();

    await gateway.emitMessageCreate({
      id: "56",
      channel_id: "chan-1",
      attachments: [
        {
          id: "att-2",
          filename: "missing.bin",
          content_type: "application/octet-stream",
          size: 10,
          url: "https://cdn.discordapp.com/attachments/1/missing.bin",
          proxy_url: "https://cdn.discordapp.com/attachments/1/missing.bin",
        },
      ],
    } as APIMessage);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.attachments?.[0]?.blob_hash, undefined);
    assert.match(
      String(received[0]!.attachments?.[0]?.platform_metadata?.retrieval_error),
      /HTTP 404/,
    );
  });
});

class InboundTestGateway implements DiscordGatewayLike {
  private dispatchHandler: ((payload: GatewayDispatchPayload) => void) | null = null;

  onDispatch(handler: (payload: GatewayDispatchPayload) => void): void {
    this.dispatchHandler = handler;
  }

  onConnectionState(): void {}

  threadParentChannelId(): string | undefined {
    return undefined;
  }

  async connect(): Promise<void> {}

  async destroy(): Promise<void> {}

  async emitMessageCreate(raw: APIMessage): Promise<void> {
    this.dispatchHandler?.({
      t: GatewayDispatchEvents.MessageCreate,
      s: 1,
      op: 0,
      d: raw,
    });
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

  async open(): Promise<ReadableStream<Uint8Array>> {
    throw new Error("not implemented");
  }

  pathFor(ref: BlobRef): string {
    return `D:\\tmp\\${ref.hash}`;
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

class NoopDiscordGateway implements DiscordGatewayLike {
  async connect(): Promise<void> {}
  async destroy(): Promise<void> {}
  onDispatch(_handler: (payload: GatewayDispatchPayload) => void): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}
  threadParentChannelId(): string | undefined {
    return undefined;
  }
}

function makeFakeRest(handlers?: {
  post?: DiscordRestLike["post"];
  get?: DiscordRestLike["get"];
}): DiscordRestLike {
  return {
    setToken() {
      return this;
    },
    destroy() {},
    get: handlers?.get ?? (async () => ({ id: "123456789012345678" })),
    post: handlers?.post ?? (async () => ({ id: "1" })),
  };
}

class RecordingBus {
  lastSend: SendRequest | null = null;

  async send(request: SendRequest): Promise<string> {
    this.lastSend = request;
    return "discord:1";
  }
}

class TargetStorage implements Partial<Storage> {
  constructor(
    private readonly registrations: AccountRegistration[],
    private readonly session: Session,
  ) {}

  async getSession(session: SessionId): Promise<Session | null> {
    return session === this.session.session_id ? this.session : null;
  }

  async listAccountRegistrations(filter?: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  }): Promise<AccountRegistration[]> {
    return this.registrations.filter((registration) => {
      if (filter?.project !== undefined && registration.project !== filter.project) return false;
      if (filter?.comm !== undefined && registration.comm !== filter.comm) return false;
      if (filter?.agent !== undefined && registration.agent !== filter.agent) return false;
      return true;
    });
  }
}

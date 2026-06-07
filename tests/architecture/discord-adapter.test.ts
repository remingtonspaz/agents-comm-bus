import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimitError } from "@discordjs/rest";

import {
  DiscordCommAdapter,
  discordMessageBody,
  type DiscordRestLike,
} from "../../adapters/discord/adapter.js";
import type { DiscordGatewayLike } from "../../adapters/discord/gateway.js";
import type { CommConnectionState } from "../../packages/core-contracts/src/index.js";
import type { GatewayDispatchPayload } from "discord-api-types/v10";
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

class NoopDiscordGateway implements DiscordGatewayLike {
  async connect(): Promise<void> {}
  async destroy(): Promise<void> {}
  onDispatch(_handler: (payload: GatewayDispatchPayload) => void): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}
  threadParentChannelId(): string | undefined {
    return undefined;
  }
}

function makeFakeRest(handlers: {
  post: DiscordRestLike["post"];
  get?: DiscordRestLike["get"];
}): DiscordRestLike {
  return {
    setToken() {
      return this;
    },
    destroy() {},
    get: handlers.get ?? (async () => ({ id: "123456789012345678" })),
    post: handlers.post,
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MatrixCommAdapter,
  type MatrixSyncClient,
  type MatrixSyncHandlers,
  type MatrixSyncResponse,
} from "../../adapters/matrix/adapter.js";
import type {
  CommConnectionState,
  FilterDropEvent,
  Message,
} from "../../packages/core-contracts/src/index.js";

const BOT_MXID = "@agents-comm-bot:matrix.example.org";
const ROOM_ID = "!room:matrix.example.org";
const ALICE_MXID = "@alice:matrix.example.org";

function baseAdapterOptions(overrides: Record<string, unknown> = {}) {
  return {
    homeserverUrl: "https://matrix.example.org",
    accessToken: "syt_test_token",
    userId: BOT_MXID,
    accountId: BOT_MXID as any,
    ...overrides,
  };
}

interface FakeSyncClient extends MatrixSyncClient {
  readonly startCalls: number;
  readonly stopCalls: number;
  pushSync(response: MatrixSyncResponse): Promise<void>;
  triggerError(error: unknown): void;
}

function createFakeSyncClient(options?: { failOnStart?: boolean }): FakeSyncClient {
  let handlers: MatrixSyncHandlers | null = null;
  let startCalls = 0;
  let stopCalls = 0;

  return {
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    async start(h: MatrixSyncHandlers) {
      startCalls += 1;
      if (options?.failOnStart) {
        throw new Error("sync start failed");
      }
      handlers = h;
    },
    async stop() {
      stopCalls += 1;
      handlers = null;
    },
    async pushSync(response: MatrixSyncResponse) {
      if (!handlers) throw new Error("fake sync client not started");
      await handlers.onSyncResponse(response);
    },
    triggerError(error: unknown) {
      handlers?.onError(error);
    },
  };
}

function textMessageEvent(overrides: {
  event_id?: string;
  sender?: string;
  body?: string;
  msgtype?: string;
  origin_server_ts?: number;
  reply_to_event_id?: string;
} = {}) {
  const content: Record<string, unknown> = {
    msgtype: overrides.msgtype ?? "m.text",
    body: overrides.body ?? "hello matrix",
  };
  if (overrides.reply_to_event_id) {
    content["m.relates_to"] = {
      "m.in_reply_to": { event_id: overrides.reply_to_event_id },
    };
  }
  return {
    type: "m.room.message",
    event_id: overrides.event_id ?? "$event123",
    sender: overrides.sender ?? ALICE_MXID,
    origin_server_ts: overrides.origin_server_ts ?? 1_700_000_000_000,
    content,
  };
}

function syncWithEvents(
  roomId: string,
  events: ReturnType<typeof textMessageEvent>[],
): MatrixSyncResponse {
  return {
    next_batch: "s0_1_2_3",
    rooms: {
      join: {
        [roomId]: {
          timeline: { events },
        },
      },
    },
  };
}

describe("MatrixCommAdapter P1 skeleton", () => {
  it("exclusiveResource returns the MXID resource id", () => {
    const adapter = new MatrixCommAdapter(baseAdapterOptions());
    assert.deepEqual(adapter.exclusiveResource(), { resourceId: BOT_MXID });
  });

  it("allowedSenderIds and updateAllowedSenderIds share backing state", () => {
    const adapter = new MatrixCommAdapter(baseAdapterOptions({
      allowedUserIds: ["@alice:matrix.example.org"],
    }));
    assert.deepEqual(adapter.allowedSenderIds, ["@alice:matrix.example.org"]);
    adapter.updateAllowedSenderIds(["@bob:matrix.example.org"]);
    assert.deepEqual(adapter.allowedSenderIds, ["@bob:matrix.example.org"]);
  });

  it("start and stop emit connection-state transitions and are idempotent enough for rollback", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));

    await adapter.start();
    await adapter.start();
    await adapter.stop();
    await adapter.stop();

    assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
  });

  it("send fails loud as unsupported and classifies permanent", async () => {
    const adapter = new MatrixCommAdapter(baseAdapterOptions());
    try {
      await adapter.send(
        {
          comm: "matrix",
          account: BOT_MXID as any,
          chat_native_id: ROOM_ID,
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
    const adapter = new MatrixCommAdapter(baseAdapterOptions());

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
    const adapter = new MatrixCommAdapter(baseAdapterOptions());
    assert.deepEqual(adapter.reportPressure(), { backlog: 0, rateLimited: false });
  });
});

describe("MatrixCommAdapter P2 default sync client", () => {
  it("issues GET /sync and delivers responses to the adapter", async () => {
    let fetchUrl: string | undefined;
    let authHeader: string | undefined;
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    let adapter: MatrixCommAdapter | null = null;

    globalThis.fetch = async (input, init) => {
      callCount += 1;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      fetchUrl = url;
      authHeader = new Headers(init?.headers).get("Authorization") ?? undefined;

      const payload = syncWithEvents(ROOM_ID, [
        textMessageEvent({ event_id: "$fetch_evt", body: "from default sync" }),
      ]);

      if (callCount === 1) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    };

    try {
      adapter = new MatrixCommAdapter(baseAdapterOptions());
      const received: Message[] = [];
      adapter.onInbound(async (msg) => {
        received.push(msg);
      });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(fetchUrl?.includes("/_matrix/client/v3/sync"));
      assert.match(fetchUrl ?? "", /timeout=\d+/);
      assert.equal(authHeader, "Bearer syt_test_token");
      assert.equal(received.length, 1);
      assert.equal(received[0]!.message_id, "matrix:$fetch_evt");
      assert.equal(received[0]!.text, "from default sync");
    } finally {
      await adapter?.stop();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("MatrixCommAdapter P2 lifecycle", () => {
  it("start emits connecting, starts sync client once, then connected", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));

    await adapter.start();

    assert.equal(syncClient.startCalls, 1);
    assert.deepEqual(states, ["connecting", "connected"]);
  });

  it("duplicate start does not start a second sync loop", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));

    await adapter.start();
    await adapter.start();

    assert.equal(syncClient.startCalls, 1);
  });

  it("stop calls sync client stop once and emits disconnected", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));

    await adapter.start();
    await adapter.stop();

    assert.equal(syncClient.stopCalls, 1);
    assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
  });

  it("partial-start failure still allows stop() rollback", async () => {
    const syncClient = createFakeSyncClient({ failOnStart: true });
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));

    await assert.rejects(() => adapter.start(), /failed to start/i);
    await adapter.stop();

    assert.equal(syncClient.startCalls, 1);
    assert.equal(syncClient.stopCalls, 1);
    assert.deepEqual(states, ["connecting", "disconnected"]);
  });
});

describe("MatrixCommAdapter P2 inbound sync", () => {
  it("maps joined-room m.text events to core Message objects", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({
        event_id: "$evt_text",
        body: "hello matrix",
        origin_server_ts: 1_700_000_000_123,
      }),
    ]));

    assert.equal(received.length, 1);
    const msg = received[0]!;
    assert.equal(msg.schema_version, 1);
    assert.equal(msg.message_id, "matrix:$evt_text");
    assert.equal(msg.platform_message_id, "$evt_text");
    assert.deepEqual(msg.chat, {
      comm: "matrix",
      account: BOT_MXID,
      chat_native_id: ROOM_ID,
    });
    assert.equal(msg.sender.id, ALICE_MXID);
    assert.equal(msg.sender.display_name, ALICE_MXID);
    assert.equal(msg.sender.isBot, false);
    assert.equal(msg.sender.isForeignBot, false);
    assert.deepEqual(msg.origin, { comm: "matrix" });
    assert.equal(msg.text, "hello matrix");
    assert.deepEqual(msg.attachments, []);
    assert.equal(msg.hop_count, 0);
    assert.equal(msg.received_at, 1_700_000_000_123);
  });

  it("maps m.notice events to core text messages", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({ msgtype: "m.notice", body: "notice body" }),
    ]));

    assert.equal(received.length, 1);
    assert.equal(received[0]!.text, "notice body");
  });

  it("maps m.relates_to reply metadata to matrix reply_to ids", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({ reply_to_event_id: "$parent_evt" }),
    ]));

    assert.equal(received.length, 1);
    assert.equal(received[0]!.reply_to, "matrix:$parent_evt");
  });

  it("uses adapter clock when origin_server_ts is missing", async () => {
    const fixedNow = 1_800_000_000_000;
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({
      syncClient,
      now: () => fixedNow,
    }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      {
        ...textMessageEvent(),
        origin_server_ts: undefined,
      },
    ]));

    assert.equal(received[0]!.received_at, fixedNow);
  });
});

describe("MatrixCommAdapter P2 filtering", () => {
  it("drops non-allowlisted senders with a FilterDropEvent", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({
      syncClient,
      allowedUserIds: [ALICE_MXID],
    }));
    const received: Message[] = [];
    const drops: FilterDropEvent[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });
    adapter.onFilterDrop((event) => {
      drops.push(event);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({ sender: "@bob:matrix.example.org" }),
    ]));

    assert.equal(received.length, 0);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.reason, "sender_not_allowed");
    assert.equal(drops[0]!.update_kind, "message");
    assert.equal(drops[0]!.sender_id, "@bob:matrix.example.org");
    assert.equal(drops[0]!.chat_native_id, ROOM_ID);
    assert.equal(drops[0]!.platform_message_id, "$event123");
  });

  it("allows allowlisted senders through", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({
      syncClient,
      allowedUserIds: [ALICE_MXID],
    }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({ sender: ALICE_MXID }),
    ]));

    assert.equal(received.length, 1);
  });

  it("drops non-allowed rooms with room id in the drop event", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({
      syncClient,
      allowedRoomIds: ["!allowed:matrix.example.org"],
    }));
    const received: Message[] = [];
    const drops: FilterDropEvent[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });
    adapter.onFilterDrop((event) => {
      drops.push(event);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [textMessageEvent()]));

    assert.equal(received.length, 0);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.reason, "sender_not_allowed");
    assert.equal(drops[0]!.chat_native_id, ROOM_ID);
  });

  it("silently ignores self-messages from accountId", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    const drops: FilterDropEvent[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });
    adapter.onFilterDrop((event) => {
      drops.push(event);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({ sender: BOT_MXID }),
    ]));

    assert.equal(received.length, 0);
    assert.equal(drops.length, 0);
  });
});

describe("MatrixCommAdapter P2 unsupported and malformed events", () => {
  it("ignores unsupported event types without throwing", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      {
        type: "m.room.member",
        event_id: "$member",
        sender: ALICE_MXID,
        content: { membership: "join" },
      } as any,
    ]));

    assert.equal(received.length, 0);
  });

  it("ignores unsupported msgtype values without throwing", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      textMessageEvent({ msgtype: "m.image", body: "ignored" }),
    ]));

    assert.equal(received.length, 0);
  });

  it("ignores malformed events missing event id or body", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    const drops: FilterDropEvent[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });
    adapter.onFilterDrop((event) => {
      drops.push(event);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      { type: "m.room.message", sender: ALICE_MXID, content: { msgtype: "m.text" } } as any,
      {
        type: "m.room.message",
        event_id: "$y",
        sender: ALICE_MXID,
        content: { msgtype: "m.text" },
      } as any,
    ]));

    assert.equal(received.length, 0);
    assert.equal(drops.length, 0);
  });

  it("emits missing_sender_id for supported messages without sender", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    const drops: FilterDropEvent[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });
    adapter.onFilterDrop((event) => {
      drops.push(event);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      {
        type: "m.room.message",
        event_id: "$no_sender",
        content: { msgtype: "m.text", body: "who sent this?" },
      } as any,
    ]));

    assert.equal(received.length, 0);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.reason, "missing_sender_id");
    assert.equal(drops[0]!.update_kind, "message");
    assert.equal(drops[0]!.chat_native_id, ROOM_ID);
    assert.equal(drops[0]!.platform_message_id, "$no_sender");
    assert.equal(drops[0]!.sender_id, undefined);
  });

  it("ignores m.room.encrypted events without throwing", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const received: Message[] = [];
    adapter.onInbound(async (msg) => {
      received.push(msg);
    });

    await adapter.start();
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [
      {
        type: "m.room.encrypted",
        event_id: "$enc",
        sender: ALICE_MXID,
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      } as any,
    ]));

    assert.equal(received.length, 0);
  });
});

describe("MatrixCommAdapter P2 degraded and recovery", () => {
  it("sync errors emit degraded and later sync responses recover to connected", async () => {
    const syncClient = createFakeSyncClient();
    const adapter = new MatrixCommAdapter(baseAdapterOptions({ syncClient }));
    const states: CommConnectionState[] = [];
    adapter.onConnectionState((state) => states.push(state));

    await adapter.start();
    syncClient.triggerError(new Error("sync failed"));
    await syncClient.pushSync(syncWithEvents(ROOM_ID, [textMessageEvent()]));

    assert.ok(states.includes("degraded"));
    assert.equal(states.at(-1), "connected");
  });
});

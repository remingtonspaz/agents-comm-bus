import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type TelegramBot from "node-telegram-bot-api";

import { TelegramCommAdapter } from "../../adapters/telegram/adapter.js";
import { MessageBus } from "../../core-daemon/bus.js";
import type {
  AccountId,
  ChatRef,
  CommConnectionState,
  CommId,
  FailureClassification,
  FilterDropEvent,
  Message,
  MessageId,
  OutboundPayload,
  SendResult,
} from "../../packages/core-contracts/src/index.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

interface CapturedAudit {
  kind: string;
  detail?: Record<string, unknown>;
}

function makeAdapterHarness(options: {
  allowedUserIds?: readonly string[];
  filterTrace?: boolean;
}) {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const fakeBot = {
    getMe: async () => ({ id: 555 }),
    on: (event: string, handler: (arg: unknown) => void) => {
      handlers[event] = handler;
    },
    isPolling: () => false,
    stopPolling: async () => {},
  } as unknown as TelegramBot;

  const logged: string[] = [];
  const drops: FilterDropEvent[] = [];
  const received: Message[] = [];

  const adapter = new TelegramCommAdapter({
    botToken: "test",
    accountId: "555" as AccountId,
    bot: fakeBot,
    polling: false,
    allowedUserIds: options.allowedUserIds,
    filterTrace: options.filterTrace ?? false,
    log: (m) => logged.push(m),
  });
  adapter.onInbound(async (msg) => {
    received.push(msg);
  });
  adapter.onFilterDrop((event) => drops.push(event));

  return { adapter, handlers, logged, drops, received };
}

function rawMessage(overrides: Record<string, unknown> = {}): unknown {
  return {
    message_id: 7,
    chat: { id: -42 },
    from: { id: 999, is_bot: false, username: "intruder" },
    text: "hello",
    date: 1,
    ...overrides,
  };
}

describe("AGE-10 adapter-level inbound filter drops are observable", () => {
  it("emits sender_not_allowed for a message from a non-allowlisted sender (and does not deliver it)", async () => {
    const h = makeAdapterHarness({ allowedUserIds: ["100"] });
    await h.adapter.start();

    h.handlers["message"]?.(rawMessage());
    await tick();
    await tick();

    assert.equal(h.received.length, 0, "the message must not reach the inbound handler");
    assert.equal(h.drops.length, 1, "exactly one drop event");
    assert.deepEqual(h.drops[0], {
      reason: "sender_not_allowed",
      update_kind: "message",
      sender_id: "999",
      chat_native_id: "-42",
      platform_message_id: "7",
    });
  });

  it("emits missing_sender_id when the allowlist is active and the update has no sender", async () => {
    const h = makeAdapterHarness({ allowedUserIds: ["100"] });
    await h.adapter.start();

    h.handlers["message"]?.(rawMessage({ from: undefined }));
    await tick();
    await tick();

    assert.equal(h.received.length, 0);
    assert.equal(h.drops.length, 1);
    assert.equal(h.drops[0].reason, "missing_sender_id");
    assert.equal(h.drops[0].update_kind, "message");
    assert.equal(h.drops[0].sender_id, undefined);
  });

  it("emits sender_not_allowed for a callback from a non-allowlisted sender", async () => {
    const h = makeAdapterHarness({ allowedUserIds: ["100"] });
    const callbacks: unknown[] = [];
    h.adapter.onCallback(async (event) => {
      callbacks.push(event);
    });
    await h.adapter.start();

    h.handlers["callback_query"]?.({
      id: "cb1",
      data: "resolve:q_1:1",
      from: { id: 999 },
      message: { message_id: 8, chat: { id: -42 } },
    });
    await tick();
    await tick();

    assert.equal(callbacks.length, 0, "the callback must not reach handlers");
    assert.equal(h.drops.length, 1);
    assert.deepEqual(h.drops[0], {
      reason: "sender_not_allowed",
      update_kind: "callback",
      sender_id: "999",
      chat_native_id: "-42",
      platform_message_id: "8",
    });
  });

  it("does NOT emit a drop for an allowlisted sender (message flows through)", async () => {
    const h = makeAdapterHarness({ allowedUserIds: ["999"] });
    await h.adapter.start();

    h.handlers["message"]?.(rawMessage());
    await tick();
    await tick();

    assert.equal(h.drops.length, 0, "allowed traffic must not produce drop events");
    assert.equal(h.received.length, 1, "allowed traffic flows to the inbound handler");
    assert.equal(h.received[0].sender.id, "999");
  });

  it("does NOT filter (or emit drops) when the allowlist is empty", async () => {
    const h = makeAdapterHarness({ allowedUserIds: [] });
    await h.adapter.start();

    h.handlers["message"]?.(rawMessage());
    await tick();
    await tick();

    assert.equal(h.drops.length, 0);
    assert.equal(h.received.length, 1, "empty allowlist means no filtering");
  });

  it("filterTrace logs drops AND passes when enabled, and nothing when disabled", async () => {
    const traced = makeAdapterHarness({ allowedUserIds: ["999"], filterTrace: true });
    await traced.adapter.start();
    traced.handlers["message"]?.(rawMessage()); // pass (999 allowed)
    traced.handlers["message"]?.(rawMessage({ from: { id: 31337, is_bot: false } })); // drop
    await tick();
    await tick();
    const traceLines = traced.logged.join("\n");
    assert.match(traceLines, /filter pass: message sender=999/);
    assert.match(traceLines, /FILTER DROP: message sender=31337 .*reason=sender_not_allowed/);

    const silent = makeAdapterHarness({ allowedUserIds: ["999"], filterTrace: false });
    await silent.adapter.start();
    silent.handlers["message"]?.(rawMessage());
    silent.handlers["message"]?.(rawMessage({ from: { id: 31337, is_bot: false } }));
    await tick();
    await tick();
    assert.equal(
      silent.logged.filter((l) => /FILTER DROP|filter pass/.test(l)).length,
      0,
      "trace lines must be gated behind filterTrace",
    );
    assert.equal(silent.drops.length, 1, "the structured drop event still fires with trace off");
  });
});

// ---------------------------------------------------------------------------
// Bus wiring: registerComm hooks onFilterDrop into the audit log, and the
// foreign-bot gate's loop_prevention_drop now carries actionable context.
// ---------------------------------------------------------------------------

class DroppyAdapter {
  readonly id = "telegram" as CommId;
  readonly accountId = "botX" as AccountId;
  readonly allowedSenderIds: readonly string[] = [];
  dropHandler: ((event: FilterDropEvent) => void) | null = null;

  onFilterDrop(handler: (event: FilterDropEvent) => void): void {
    this.dropHandler = handler;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onInbound(_handler: (msg: Message) => Promise<void>): void {}
  onConnectionState(_handler: (state: CommConnectionState) => void): void {}
  async send(
    _target: ChatRef,
    _payload: OutboundPayload,
    _idempotencyKey: string,
  ): Promise<SendResult> {
    return { platform_message_id: "x", sent_at: 1 };
  }
  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure(_error: unknown): FailureClassification {
    return "transient";
  }
}

function makeBusHarness() {
  const audits: CapturedAudit[] = [];
  const bus = new MessageBus({
    project: "p",
    storage: {} as never,
    transcripts: { append: async () => {} } as never,
    audit: { append: async (event: CapturedAudit) => void audits.push(event) } as never,
    blobs: {} as never,
    comms: [],
  });
  return { bus, audits };
}

describe("AGE-10 bus wiring for filter-drop observability", () => {
  it("registerComm wires onFilterDrop to an inbound_filter_drop audit event with comm+account context", async () => {
    const { bus, audits } = makeBusHarness();
    const adapter = new DroppyAdapter();
    bus.registerComm(adapter as never);

    assert.ok(adapter.dropHandler, "registerComm must subscribe to onFilterDrop");
    adapter.dropHandler!({
      reason: "sender_not_allowed",
      update_kind: "message",
      sender_id: "999",
      chat_native_id: "-42",
      platform_message_id: "7",
    });
    await tick();

    const drop = audits.find((a) => a.kind === "inbound_filter_drop");
    assert.ok(drop, "the drop must reach the audit log");
    assert.deepEqual(drop!.detail, {
      comm: "telegram",
      account: "botX",
      reason: "sender_not_allowed",
      update_kind: "message",
      sender_id: "999",
      chat_native_id: "-42",
      platform_message_id: "7",
    });
  });

  it("the foreign-bot gate's loop_prevention_drop now identifies the bot, chat, and message", async () => {
    const { bus, audits } = makeBusHarness();
    const foreignBotMessage: Message = {
      schema_version: 1,
      message_id: "telegram:55" as MessageId,
      chat: {
        comm: "telegram" as CommId,
        account: "botX" as AccountId,
        chat_native_id: "-42",
      },
      sender: {
        id: "31337",
        display_name: "other_bot",
        isBot: true,
        isForeignBot: true,
      },
      origin: { comm: "telegram" as CommId },
      text: "beep",
      hop_count: 0,
      received_at: 1,
      platform_message_id: "55",
    };

    await assert.rejects(
      () => bus.receiveInbound(foreignBotMessage),
      /foreign bot sender rejected/,
    );

    const drop = audits.find((a) => a.kind === "loop_prevention_drop");
    assert.ok(drop, "the foreign-bot drop must be audited");
    assert.equal(drop!.detail?.reason, "foreign_bot");
    assert.equal(drop!.detail?.comm, "telegram");
    assert.equal(drop!.detail?.account, "botX");
    assert.equal(drop!.detail?.chat_native_id, "-42");
    assert.equal(drop!.detail?.platform_message_id, "55");
    assert.equal(drop!.detail?.sender_is_bot, true);
    assert.equal(drop!.detail?.sender_id, "31337");
  });
});

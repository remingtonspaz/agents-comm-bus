/**
 * AGE-93: audit kinds mean what they say.
 *
 * Before this fix, bus.ts audited connection lifecycle transitions as
 * message-level events ("disconnected" → outbound_failed, every other state →
 * inbound_received), fabricating ~350 fake delivery events/day fleet-wide —
 * while a REAL comm.send failure emitted nothing at all (uncaught throw before
 * the outbound_sent append). The kind was inverted in both directions.
 *
 * Pinned here:
 *  1. All four CommConnectionState values emit connection_state_changed — and
 *     lifecycle NEVER emits inbound_received or outbound_failed.
 *  2. A throwing comm.send emits exactly one outbound_failed with the resolved
 *     routing identity + sanitized error, and the caller gets the ORIGINAL
 *     error object back.
 *  3. Rethrow-literal: a failing audit append does NOT mask the original error.
 *  4. A throwing classifyFailure is guarded: audit still emitted, no
 *     classification field, original error rethrown.
 *  5. A successful send emits outbound_sent and zero outbound_failed.
 *
 * Mutation targets (each must turn a distinct test red): restoring the old
 * lifecycle mapping (#1), deleting the send-failure audit (#2), nesting the
 * rethrow so audit failure masks (#3), calling classifyFailure unguarded (#4).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AccountRegistration,
  AuditEvent,
  ChatRef,
  CommAdapter,
  Conversation,
  MessageId,
  OutboundPayload,
  Storage,
} from "agents-comm-bus-core";
import type { CommConnectionState } from "../../packages/core-contracts/src/contracts/comm-adapter.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { MessageBus } from "../../core-daemon/bus.js";

const TELEGRAM = "telegram";
const CLAUDE = "claude";
const PROJECT = normalizeProjectPath("/repo/age93");
const BOT = "bot-1";
const CHAT = "chat-1";

function registration(): AccountRegistration {
  return {
    schema_version: 1,
    registration_id: "reg-1",
    project: PROJECT,
    comm: TELEGRAM,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: BOT,
    credentials_ref: "file:/tmp/nope",
  } as unknown as AccountRegistration;
}

function conversation(): Conversation {
  return {
    schema_version: 1,
    project: PROJECT,
    comm: TELEGRAM,
    account_label: "main",
    bot_user_id: BOT,
    registration_id: "reg-1",
    agent: CLAUDE,
    chat_native_id: CHAT,
    thread_native_id: null,
    conversation_id: "conv-1" as Conversation["conversation_id"],
    last_inbound_at: null,
    last_outbound_at: null,
  } as unknown as Conversation;
}

class FakeStorage {
  async getAccountByBot(_comm: string, bot: string) {
    return bot === BOT ? registration() : undefined;
  }
  async findConversation() {
    return conversation();
  }
  async upsertConversation(rec: Conversation) {
    return rec.conversation_id;
  }
  async touchConversationOutbound() {}
}

interface FakeComm extends CommAdapter {
  sentPayloads: OutboundPayload[];
  connectionStateHandler?: (state: CommConnectionState) => void;
}

function fakeComm(opts: {
  sendError?: Error;
  classifierError?: Error;
  classification?: "permanent" | "transient" | "rate_limited";
} = {}): FakeComm {
  const comm: FakeComm = {
    id: TELEGRAM,
    accountId: BOT as never,
    sentPayloads: [],
    onInbound() {},
    onConnectionState(handler: (state: CommConnectionState) => void) {
      comm.connectionStateHandler = handler;
    },
    async send(_target: ChatRef, payload: OutboundPayload, _key: string) {
      if (opts.sendError) throw opts.sendError;
      comm.sentPayloads.push(payload);
      return { platform_message_id: "p-1", sent_at: 2000 };
    },
    async start() {},
    async stop() {},
    reportPressure() {},
    classifyFailure(error: unknown) {
      if (opts.classifierError) throw opts.classifierError;
      if (error === opts.sendError && opts.classification) return opts.classification;
      return "transient";
    },
  } as unknown as FakeComm;
  return comm;
}

function makeBus(audit: AuditEvent[], comms: CommAdapter[]) {
  return new MessageBus({
    project: PROJECT,
    storage: new FakeStorage() as unknown as Storage,
    transcripts: { async append() {}, async *read() {} } as never,
    audit: { async append(e: AuditEvent) { audit.push(e); } },
    comms,
    now: () => 2000,
  });
}

const SEND_REQUEST = {
  session: "s-1" as never,
  comm: TELEGRAM,
  payload: { text: "hi" },
  target: { comm: TELEGRAM, account: BOT, chat_native_id: CHAT } as never,
};

describe("AGE-93 connection lifecycle audits as connection_state_changed", () => {
  it("all four states emit connection_state_changed; lifecycle emits NO message kinds", async () => {
    const audit: AuditEvent[] = [];
    const comm = fakeComm();
    makeBus(audit, [comm]);
    assert.ok(comm.connectionStateHandler, "bus registered a connection-state handler");

    for (const state of ["connecting", "connected", "degraded", "disconnected"] as const) {
      comm.connectionStateHandler(state);
    }
    await new Promise((r) => setImmediate(r));

    const lifecycle = audit.filter((e) => e.kind === "connection_state_changed");
    assert.deepEqual(
      lifecycle.map((e) => (e.detail as { connection_state: string }).connection_state),
      ["connecting", "connected", "degraded", "disconnected"],
    );
    assert.equal(lifecycle.every((e) => (e.detail as { account: string }).account === BOT), true);
    assert.equal(
      audit.filter((e) => e.kind === "inbound_received").length,
      0,
      "lifecycle must not fabricate inbound_received (the 96-98% contamination)",
    );
    assert.equal(
      audit.filter((e) => e.kind === "outbound_failed").length,
      0,
      "lifecycle must not fabricate outbound_failed",
    );
  });
});

describe("AGE-93 real send failures emit outbound_failed", () => {
  it("throwing comm.send → exactly one outbound_failed with routing identity; original error rethrown", async () => {
    const audit: AuditEvent[] = [];
    const sendError = new Error("discord gateway 500");
    const comm = fakeComm({ sendError, classification: "transient" });
    const bus = makeBus(audit, [comm]);

    const thrown = await bus.send(SEND_REQUEST as never).then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(thrown, sendError, "caller must receive the ORIGINAL error object");

    const failures = audit.filter((e) => e.kind === "outbound_failed");
    assert.equal(failures.length, 1, "exactly one outbound_failed per failed send");
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.account, BOT);
    assert.equal(detail.account_label, "main");
    assert.equal(detail.chat_native_id, CHAT);
    assert.equal(detail.error, "discord gateway 500");
    assert.equal(detail.failure_classification, "transient");
    assert.equal(failures[0].agent, CLAUDE);
    assert.equal(audit.filter((e) => e.kind === "outbound_sent").length, 0);
  });

  it("rethrow-literal: a failing audit append does not mask the original send error", async () => {
    const sendError = new Error("send exploded");
    const comm = fakeComm({ sendError });
    const bus = new MessageBus({
      project: PROJECT,
      storage: new FakeStorage() as unknown as Storage,
      transcripts: { async append() {}, async *read() {} } as never,
      audit: {
        async append() {
          throw new Error("audit store is on fire");
        },
      },
      comms: [comm],
      now: () => 2000,
    });

    const thrown = await bus.send(SEND_REQUEST as never).then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(
      thrown,
      sendError,
      "audit-append failure must never replace the original send error",
    );
  });

  it("guarded classifyFailure: classifier throw still audits, omits classification, rethrows original", async () => {
    const audit: AuditEvent[] = [];
    const sendError = new Error("send exploded");
    const comm = fakeComm({ sendError, classifierError: new Error("classifier exploded") });
    const bus = makeBus(audit, [comm]);

    const thrown = await bus.send(SEND_REQUEST as never).then(
      () => null,
      (e: unknown) => e,
    );
    assert.equal(thrown, sendError);

    const failures = audit.filter((e) => e.kind === "outbound_failed");
    assert.equal(failures.length, 1, "audit still emitted when the classifier throws");
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.error, "send exploded");
    assert.equal(
      "failure_classification" in detail,
      false,
      "no classification field when classifyFailure itself fails",
    );
  });

  it("successful send emits outbound_sent and zero outbound_failed", async () => {
    const audit: AuditEvent[] = [];
    const comm = fakeComm();
    const bus = makeBus(audit, [comm]);

    const id: MessageId = await bus.send(SEND_REQUEST as never);
    assert.equal(id, "telegram:p-1");
    assert.equal(comm.sentPayloads.length, 1);
    assert.equal(audit.filter((e) => e.kind === "outbound_sent").length, 1);
    assert.equal(audit.filter((e) => e.kind === "outbound_failed").length, 0);
  });
});

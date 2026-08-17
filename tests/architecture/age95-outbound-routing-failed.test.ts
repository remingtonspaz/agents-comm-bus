/**
 * AGE-95: pre-adapter routing failures in MessageBus.send are audited.
 *
 * Before this fix, the four pre-`comm.send` failure paths (target resolution,
 * comm mismatch, registration resolution, adapter-not-registered) threw with
 * ZERO audit rows — the "agent went silent vs routing broke" ambiguity that
 * ate real sends during AGE-93/94 review. Each now emits one
 * `outbound_routing_failed` with a discriminating reason, progressive routing
 * identity (no payload content), then rethrows the ORIGINAL error object
 * (rethrow-literal; an audit-append failure must never mask it).
 *
 * Distinct from AGE-93's `outbound_failed` ("adapter attempted delivery and
 * failed") so the kinds don't re-blur.
 *
 * Mutation targets: deleting any one audit call must red exactly that
 * reason's test; making the helper throw must red the append-failure test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AccountRegistration,
  AuditEvent,
  Conversation,
  Storage,
} from "agents-comm-bus-core";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { MessageBus } from "../../core-daemon/bus.js";

const TELEGRAM = "telegram";
const DISCORD = "discord";
const CLAUDE = "claude";
const PROJECT = normalizeProjectPath("/repo/age95");
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
  session: unknown;
  async getAccountByBot(_comm: string, bot: string) {
    return bot === BOT ? registration() : undefined;
  }
  async findConversation() {
    return conversation();
  }
  async getConversation(id: string) {
    return id === "conv-1" ? conversation() : undefined;
  }
  async upsertConversation(rec: Conversation) {
    return rec.conversation_id;
  }
  async touchConversationOutbound() {}
  async getSession() {
    return this.session; // undefined → targetFromSession throws
  }
  async listSessions() {
    return [];
  }
}

function makeBus(audit: AuditEvent[], opts: { auditThrows?: boolean } = {}) {
  return new MessageBus({
    project: PROJECT,
    storage: new FakeStorage() as unknown as Storage,
    transcripts: { async append() {}, async *read() {} } as never,
    audit: {
      async append(e: AuditEvent) {
        if (opts.auditThrows) throw new Error("audit store is on fire");
        audit.push(e);
      },
    },
    comms: [], // no adapters registered → adapter_not_registered reachable
    now: () => 2000,
  });
}

function routingFailures(audit: AuditEvent[]) {
  return audit.filter((e) => e.kind === "outbound_routing_failed");
}

describe("AGE-95 outbound_routing_failed", () => {
  it("target_resolution_failed: no explicit target + no session inbound → partial identity, original error", async () => {
    const audit: AuditEvent[] = [];
    const bus = makeBus(audit);
    const thrown = await bus
      .send({ session: "s-1" as never, comm: TELEGRAM, payload: { text: "hi" } } as never)
      .then(() => null, (e: unknown) => e);

    assert.match(String((thrown as Error).message), /no most-recent inbound/);
    const failures = routingFailures(audit);
    assert.equal(failures.length, 1);
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.reason, "target_resolution_failed");
    assert.equal(detail.comm, TELEGRAM);
    assert.equal(failures[0].session, "s-1");
    // Progressive identity: no target exists yet, so no target/account fields.
    assert.equal("target_account" in detail, false);
    assert.equal("account" in detail, false);
  });

  it("comm_mismatch: target comm differs from request comm", async () => {
    const audit: AuditEvent[] = [];
    const bus = makeBus(audit);
    const thrown = await bus
      .send({
        session: "s-1" as never,
        comm: TELEGRAM,
        payload: { text: "hi" },
        target: { comm: DISCORD, account: BOT, chat_native_id: CHAT },
      } as never)
      .then(() => null, (e: unknown) => e);

    assert.match(String((thrown as Error).message), /does not match/);
    const failures = routingFailures(audit);
    assert.equal(failures.length, 1);
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.reason, "comm_mismatch");
    assert.equal(detail.target_comm, DISCORD, "the row must name the comm it mismatched WITH");
    assert.equal(detail.target_account, BOT);
    assert.equal(detail.chat_native_id, CHAT);
    assert.equal("account" in detail, false, "no registration identity before registration resolves");
  });

  it("registration_resolution_failed: unknown bot → target context present, no registration identity", async () => {
    const audit: AuditEvent[] = [];
    const bus = makeBus(audit);
    const thrown = await bus
      .send({
        session: "s-1" as never,
        comm: TELEGRAM,
        payload: { text: "hi" },
        target: { comm: TELEGRAM, account: "bot-unknown", chat_native_id: CHAT },
      } as never)
      .then(() => null, (e: unknown) => e);

    assert.match(String((thrown as Error).message), /not a registered bot id/);
    const failures = routingFailures(audit);
    assert.equal(failures.length, 1);
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.reason, "registration_resolution_failed");
    assert.equal(detail.target_account, "bot-unknown");
    assert.equal("account" in detail, false, "must not claim a registration it failed to resolve");
  });

  it("adapter_not_registered: registration resolves, no adapter → full identity incl. account", async () => {
    const audit: AuditEvent[] = [];
    const bus = makeBus(audit); // comms: [] — no adapter for the registered bot
    const thrown = await bus
      .send({
        session: "s-1" as never,
        comm: TELEGRAM,
        payload: { text: "hi" },
        target: { comm: TELEGRAM, account: BOT, chat_native_id: CHAT },
      } as never)
      .then(() => null, (e: unknown) => e);

    assert.match(String((thrown as Error).message), /comm adapter not registered/);
    const failures = routingFailures(audit);
    assert.equal(failures.length, 1);
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.reason, "adapter_not_registered");
    assert.equal(detail.account, BOT);
    assert.equal(detail.account_label, "main");
    assert.equal(detail.chat_native_id, CHAT);
    assert.equal(failures[0].agent, CLAUDE);
  });

  it("rethrow-literal: a failing audit append does not mask the original routing error", async () => {
    const bus = makeBus([], { auditThrows: true });
    const thrown = await bus
      .send({
        session: "s-1" as never,
        comm: TELEGRAM,
        payload: { text: "hi" },
        target: { comm: TELEGRAM, account: "bot-unknown", chat_native_id: CHAT },
      } as never)
      .then(() => null, (e: unknown) => e);

    assert.match(
      String((thrown as Error).message),
      /not a registered bot id/,
      "the caller must get the original routing error, not the audit failure",
    );
  });

  it("rethrow-literal by IDENTITY: a non-Error sentinel survives registration failure + audit failure", async () => {
    // B2 (Codex review): message-only assertions let an identity-breaking
    // rewrap stay green. Throw a non-Error sentinel from storage; the caller
    // must receive that exact object even when the audit append also fails.
    const sentinel = { weird: "non-error throw", code: 42 };
    const audit: AuditEvent[] = [];
    const storage = new FakeStorage();
    storage.getAccountByBot = async () => {
      throw sentinel;
    };
    const bus = new MessageBus({
      project: PROJECT,
      storage: storage as unknown as Storage,
      transcripts: { async append() {}, async *read() {} } as never,
      audit: {
        async append(e: AuditEvent) {
          audit.push(e);
          throw new Error("audit store is on fire");
        },
      },
      comms: [],
      now: () => 2000,
    });

    const thrown = await bus
      .send({
        session: "s-1" as never,
        comm: TELEGRAM,
        payload: { text: "hi" },
        target: { comm: TELEGRAM, account: BOT, chat_native_id: CHAT },
      } as never)
      .then(() => null, (e: unknown) => e);

    assert.strictEqual(
      thrown,
      sentinel,
      "the object leaving must be the object that arrived, even a non-Error, even with audit down",
    );
    const failures = routingFailures(audit);
    assert.equal(failures.length, 1, "audit still emitted before the append failed");
    const detail = failures[0].detail as Record<string, unknown>;
    assert.equal(detail.reason, "registration_resolution_failed");
    assert.match(String(detail.error), /weird|object/, "sanitized error string, not the sentinel itself");
  });
});

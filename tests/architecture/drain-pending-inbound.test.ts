import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  AccountId,
  CommId,
  ConversationId,
  Message,
  MessageId,
} from "../../packages/core-contracts/src/index.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { drainPendingInbound } from "../../core-daemon/daemon.js";

const TELEGRAM = "telegram" as CommId;
const MATRIX = "matrix" as CommId;

function entry(
  id: string,
  comm: CommId,
  sender = "user-1",
): PendingInboundEntry {
  const message: Message = {
    schema_version: 1,
    message_id: `${comm}:${id}` as MessageId,
    chat: {
      comm,
      account: "bot-account" as AccountId,
      chat_native_id: "chat-1",
    },
    sender: {
      id: sender,
      display_name: sender,
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm },
    text: `msg ${id}`,
    hop_count: 0,
    received_at: Number(id),
    platform_message_id: id,
  };
  return {
    message,
    conversation: {
      schema_version: 1,
      project: "p",
      comm,
      account_label: "main",
      chat_native_id: "chat-1",
      thread_native_id: null,
      conversation_id: `conv-${comm}-${id}` as ConversationId,
      agent: "claude" as never,
      last_inbound_at: Number(id),
      last_outbound_at: null,
      last_message_id: `${comm}:${id}` as MessageId,
      created_at: Number(id),
    },
  };
}

describe("drainPendingInbound (scoped drain)", () => {
  it("removes ONLY entries matching the comm filter and leaves others in the queue", () => {
    const queue: PendingInboundEntry[] = [
      entry("1", TELEGRAM),
      entry("2", MATRIX),
      entry("3", TELEGRAM),
      entry("4", MATRIX),
    ];

    const drained = drainPendingInbound(queue, { comm: "telegram" });

    assert.equal(drained.length, 2);
    assert.deepEqual(
      drained.map((e) => e.message.platform_message_id),
      ["1", "3"],
      "drained should preserve queue order (oldest first)",
    );
    assert.equal(queue.length, 2);
    assert.deepEqual(
      queue.map((e) => e.message.platform_message_id),
      ["2", "4"],
      "non-matching entries must remain in original order",
    );
  });

  it("preserves order across mixed-comm drains", () => {
    // Interleaved order: T, M, M, T, M, T → drain telegram → expect [T1, T4, T6]
    const queue: PendingInboundEntry[] = [
      entry("1", TELEGRAM),
      entry("2", MATRIX),
      entry("3", MATRIX),
      entry("4", TELEGRAM),
      entry("5", MATRIX),
      entry("6", TELEGRAM),
    ];

    const drained = drainPendingInbound(queue, { comm: "telegram" });

    assert.deepEqual(
      drained.map((e) => e.message.platform_message_id),
      ["1", "4", "6"],
      "reverse-loop + unshift must yield original oldest-first order",
    );
    assert.deepEqual(
      queue.map((e) => e.message.platform_message_id),
      ["2", "3", "5"],
      "remaining entries must keep their original relative order",
    );
  });

  it("drains the entire queue when comm is omitted (global drain path)", () => {
    const queue: PendingInboundEntry[] = [
      entry("1", TELEGRAM),
      entry("2", MATRIX),
      entry("3", TELEGRAM),
    ];

    const drained = drainPendingInbound(queue, {});

    assert.equal(drained.length, 3);
    assert.deepEqual(
      drained.map((e) => e.message.platform_message_id),
      ["1", "2", "3"],
      "global drain preserves order",
    );
    assert.equal(queue.length, 0);
  });

  it("drains everything when params is undefined (defensive default)", () => {
    const queue: PendingInboundEntry[] = [entry("1", TELEGRAM)];
    const drained = drainPendingInbound(queue);
    assert.equal(drained.length, 1);
    assert.equal(queue.length, 0);
  });

  it("treats empty-string comm as 'no filter' rather than 'no comm matches'", () => {
    const queue: PendingInboundEntry[] = [
      entry("1", TELEGRAM),
      entry("2", MATRIX),
    ];

    const drained = drainPendingInbound(queue, { comm: "" });

    assert.equal(drained.length, 2, "empty string should NOT filter");
    assert.equal(queue.length, 0);
  });

  it("returns an empty array when no entries match the filter", () => {
    const queue: PendingInboundEntry[] = [
      entry("1", TELEGRAM),
      entry("2", TELEGRAM),
    ];

    const drained = drainPendingInbound(queue, { comm: "matrix" });

    assert.equal(drained.length, 0);
    assert.equal(queue.length, 2, "no entries removed when filter matches nothing");
  });
});

function entryAcct(id: string, comm: CommId, account: string): PendingInboundEntry {
  const e = entry(id, comm);
  e.message.chat.account = account as AccountId;
  return e;
}

describe("drainPendingInbound (account-scoped drain)", () => {
  it("removes only the caller's owned-account entries, leaving another agent's entries", () => {
    // Claude + Codex share comm=telegram with different bot accounts. A Claude
    // check must not cannibalize Codex's pending inbound, and vice versa.
    const queue: PendingInboundEntry[] = [
      entryAcct("1", TELEGRAM, "claude-bot"),
      entryAcct("2", TELEGRAM, "codex-bot"),
      entryAcct("3", TELEGRAM, "claude-bot"),
    ];

    const drained = drainPendingInbound(queue, {
      ownedAccountKeys: new Set(["telegram:claude-bot"]),
    });

    assert.deepEqual(
      drained.map((e) => e.message.platform_message_id),
      ["1", "3"],
      "only claude-owned entries drain",
    );
    assert.deepEqual(
      queue.map((e) => e.message.platform_message_id),
      ["2"],
      "the codex-bot entry must survive the claude check",
    );
  });

  it("drains nothing for an empty owned set (unknown session must not global-wipe)", () => {
    const queue: PendingInboundEntry[] = [entryAcct("1", TELEGRAM, "claude-bot")];

    const drained = drainPendingInbound(queue, { ownedAccountKeys: new Set<string>() });

    assert.equal(drained.length, 0);
    assert.equal(queue.length, 1, "empty owned set must NOT fall through to a global drain");
  });

  it("combines the comm filter with account ownership", () => {
    const queue: PendingInboundEntry[] = [
      entryAcct("1", TELEGRAM, "claude-bot"),
      entryAcct("2", MATRIX, "claude-bot"),
      entryAcct("3", TELEGRAM, "codex-bot"),
    ];

    const drained = drainPendingInbound(queue, {
      comm: "telegram",
      ownedAccountKeys: new Set(["telegram:claude-bot", "matrix:claude-bot"]),
    });

    assert.deepEqual(
      drained.map((e) => e.message.platform_message_id),
      ["1"],
      "must match BOTH the comm filter and account ownership",
    );
    assert.deepEqual(
      queue.map((e) => e.message.platform_message_id),
      ["2", "3"],
      "matrix-owned and codex-owned entries remain",
    );
  });
});

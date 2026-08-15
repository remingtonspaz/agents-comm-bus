/**
 * AGE-94: the inbound dispatch loop enforces a central ownership default-deny.
 *
 * Before this fix, `daemon.ts` invoked `onInboundConversation` on EVERY
 * wake-capable bridge for every inbound and audited `inbound_dispatch_bridge_invoked`
 * BEFORE the bridge's own guard ran — so the audit claimed a foreign bridge
 * acted (e.g. "codex invoked for a claude conversation") when the bridge
 * actually no-op'd. The default-deny lived only in the bridge implementations,
 * not the contract.
 *
 * `dispatchInboundToBridges` now gates centrally: only the bridge whose
 * `agentId === conversation.agent` is invoked or audited.
 *
 * The fake bridges here DELIBERATELY DO NOT carry the ClaudeBridge/CodexBridge
 * first-line agent guard. That is load-bearing: if they did, removing the
 * central gate would leave this suite green (the bridge-local guard would
 * no-op the foreign call). Unguarded fakes make the central gate the ONLY thing
 * standing between a foreign bridge and an invoke+audit, so a gate regression
 * reds the first test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditEvent, Conversation, Message } from "agents-comm-bus-core";
import type { AgentBridge } from "../../core-daemon/runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { dispatchInboundToBridges } from "../../core-daemon/runtime/dispatch-inbound.js";

function fakeBridge(
  agentId: string,
  opts: { throwOnInbound?: Error; onCalled?: () => void } = {},
) {
  const calls: Array<{ conversation: Conversation; message: Message }> = [];
  const bridge = {
    agentId,
    async onInboundConversation(conversation: Conversation, message: Message) {
      calls.push({ conversation, message });
      opts.onCalled?.();
      if (opts.throwOnInbound) throw opts.throwOnInbound;
    },
  } as unknown as AgentBridge;
  return { bridge, calls };
}

function conversation(agent: string): Conversation {
  return {
    conversation_id: `conv-${agent}`,
    agent,
  } as unknown as Conversation;
}

function message(): Message {
  return {
    platform_message_id: "p-1",
    message_id: "telegram:p-1",
  } as unknown as Message;
}

function collectAudit() {
  const events: AuditEvent[] = [];
  return {
    events,
    sink: {
      async append(event: AuditEvent) {
        events.push(event);
      },
    },
  };
}

function pending(n: number): PendingInboundEntry[] {
  return Array.from({ length: n }, () => ({}) as PendingInboundEntry);
}

describe("AGE-94 central ownership default-deny in inbound dispatch", () => {
  it("only the owning bridge is invoked and audited; the foreign bridge gets neither", async () => {
    const claude = fakeBridge("claude");
    const codex = fakeBridge("codex");
    const { events, sink } = collectAudit();

    await dispatchInboundToBridges(
      [claude.bridge, codex.bridge],
      conversation("claude"),
      message(),
      sink,
      pending(1),
    );

    assert.equal(claude.calls.length, 1, "owning (claude) bridge invoked exactly once");
    assert.equal(codex.calls.length, 0, "foreign (codex) bridge never invoked");

    const invoked = events.filter((e) => e.kind === "inbound_dispatch_bridge_invoked");
    const completed = events.filter((e) => e.kind === "inbound_dispatch_bridge_completed");
    assert.equal(invoked.length, 1, "exactly one invoked audit row");
    assert.equal(completed.length, 1, "exactly one completed audit row");
    assert.equal(invoked[0].agent, "claude");
    assert.equal(completed[0].agent, "claude");

    // The foreign bridge must appear in NO audit row at all — the core defect
    // was auditing a foreign bridge as invoked. Removing the central gate reds
    // this assertion (codex would be invoked + audited).
    assert.equal(
      events.filter((e) => e.agent === "codex").length,
      0,
      "foreign bridge must not appear in any dispatch audit row",
    );
  });

  it("owner is selected regardless of bridge order (foreign bridge listed first)", async () => {
    const claude = fakeBridge("claude");
    const codex = fakeBridge("codex");
    const { events, sink } = collectAudit();

    await dispatchInboundToBridges(
      [codex.bridge, claude.bridge],
      conversation("claude"),
      message(),
      sink,
      pending(1),
    );

    assert.equal(claude.calls.length, 1);
    assert.equal(codex.calls.length, 0);
    assert.equal(events.filter((e) => e.agent === "codex").length, 0);
  });

  it("fail closed: no owning bridge → nothing invoked or audited, durable pending untouched", async () => {
    const codex = fakeBridge("codex");
    const { events, sink } = collectAudit();
    const queue = pending(3);

    await dispatchInboundToBridges(
      [codex.bridge],
      conversation("claude"), // no claude bridge registered
      message(),
      sink,
      queue,
    );

    assert.equal(codex.calls.length, 0, "no bridge invoked");
    assert.equal(events.length, 0, "no audit rows for a conversation nobody owns");
    assert.equal(queue.length, 3, "durable pending left intact for a later owner");
  });

  it("a bridge that throws is audited as bridge_failed with the original error; dispatch does not throw", async () => {
    const boom = new Error("bridge exploded");
    const claude = fakeBridge("claude", { throwOnInbound: boom });
    const { events, sink } = collectAudit();

    await dispatchInboundToBridges(
      [claude.bridge],
      conversation("claude"),
      message(),
      sink,
      pending(1),
    ); // must not reject

    const failed = events.filter((e) => e.kind === "inbound_dispatch_bridge_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].agent, "claude");
    assert.equal((failed[0].detail as { error: string }).error, "bridge exploded");
    assert.equal(
      events.filter((e) => e.kind === "inbound_dispatch_bridge_completed").length,
      0,
      "a throwing bridge does not emit completed",
    );
  });

  it("queue_length is read live, not snapshotted: a bridge draining pending mid-dispatch is reflected", async () => {
    // Guards the extraction's one behavioral subtlety: the Codex steer path can
    // drain pendingInbound inside onInboundConversation, and queue_length must
    // reflect the length AT each audit write. A snapshot would make invoked and
    // completed report the same length — this test reds that regression.
    const queue = pending(2);
    const draining = fakeBridge("claude", { onCalled: () => queue.pop() });
    const { events, sink } = collectAudit();

    await dispatchInboundToBridges(
      [draining.bridge],
      conversation("claude"),
      message(),
      sink,
      queue,
    );

    const invoked = events.find((e) => e.kind === "inbound_dispatch_bridge_invoked");
    const completed = events.find((e) => e.kind === "inbound_dispatch_bridge_completed");
    assert.equal((invoked?.detail as { queue_length: number }).queue_length, 2);
    assert.equal(
      (completed?.detail as { queue_length: number }).queue_length,
      1,
      "completed audit reflects the live (drained) queue length",
    );
  });
});

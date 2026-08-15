import type { AuditStore, Conversation, Message } from "agents-comm-bus-core";

import type { AgentBridge } from "./agent-bridge.js";
import type { PendingInboundEntry } from "./pending-inbound.js";

/**
 * AGE-94: deliver a fresh inbound conversation to the ONE bridge that owns it.
 *
 * Central ownership default-deny. `onInboundConversation` is per-owner
 * wake/delivery, so a bridge is invoked (and audited) only when
 * `bridge.agentId === conversation.agent`. The gate is applied BEFORE the
 * `inbound_dispatch_bridge_invoked` audit and the call, so a non-owning bridge
 * is neither invoked nor audited. Previously every wake-capable bridge was
 * invoked and audited for every inbound, and each bridge's own first-line guard
 * no-op'd the foreign ones — so the audit falsely claimed a foreign bridge
 * acted. The per-bridge guards in ClaudeBridge/CodexBridge remain as
 * defense-in-depth; this gate is the contract the daemon now enforces so a
 * future bridge cannot accidentally consume foreign inbound.
 *
 * The gate forecloses nothing a bridge legitimately does: this hook is
 * owner-specific wake/delivery. There is no additive all-inbound bridge
 * observer today — the daemon owns the single dispatch sink — so a bridge that
 * needs foreign-agent inbound is separate design work, not something to reach
 * for through the sink.
 *
 * Fail closed: if no registered bridge owns the conversation, nothing is
 * invoked or audited and the durable pending entry is left intact for a later
 * owner to drain.
 *
 * `pendingInbound` is passed live (NOT a snapshot): a bridge's
 * `onInboundConversation` can drain it mid-dispatch (the Codex steer path), and
 * the `queue_length` audit field must reflect the length at the moment each row
 * is written — exactly as the original inline loop did.
 */
export async function dispatchInboundToBridges(
  bridges: readonly AgentBridge[],
  conversation: Conversation,
  message: Message,
  audit: Pick<AuditStore, "append">,
  pendingInbound: readonly PendingInboundEntry[],
): Promise<void> {
  for (const bridge of bridges) {
    // Central ownership default-deny (AGE-94). See the module comment.
    if (bridge.agentId !== conversation.agent) continue;
    if (!bridge.onInboundConversation) continue;
    try {
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_bridge_invoked",
        agent: bridge.agentId,
        conversation_id: conversation.conversation_id,
        detail: {
          conversation_agent: conversation.agent,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          queue_length: pendingInbound.length,
        },
      });
      await bridge.onInboundConversation(conversation, message);
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_bridge_completed",
        agent: bridge.agentId,
        conversation_id: conversation.conversation_id,
        detail: {
          conversation_agent: conversation.agent,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          queue_length: pendingInbound.length,
        },
      });
    } catch (error) {
      await audit.append({
        timestamp: Date.now(),
        kind: "inbound_dispatch_bridge_failed",
        agent: bridge.agentId,
        conversation_id: conversation.conversation_id,
        detail: {
          conversation_agent: conversation.agent,
          platform_message_id: message.platform_message_id,
          message_id: message.message_id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      console.error(
        `agents-comm-bus: bridge ${bridge.agentId} onInboundConversation failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

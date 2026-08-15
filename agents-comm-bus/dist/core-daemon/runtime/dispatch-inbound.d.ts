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
 * A bridge that legitimately wants to observe ALL inbound regardless of owner
 * uses `bus.setDispatchSink`, not this path — so the gate forecloses nothing.
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
export declare function dispatchInboundToBridges(bridges: readonly AgentBridge[], conversation: Conversation, message: Message, audit: Pick<AuditStore, "append">, pendingInbound: readonly PendingInboundEntry[]): Promise<void>;
//# sourceMappingURL=dispatch-inbound.d.ts.map
import type { Conversation, Message } from "../../packages/core-contracts/dist/index.js";
/**
 * Shared "messages waiting for an agent to drain" queue. Populated by the
 * daemon's dispatch sink on every inbound conversation; drained by agent
 * bridges (via `claude_drain_inbound`) and comm-MCP IPC methods (via
 * `telegram_check_messages`). The queue is daemon-owned so adapters can be
 * agnostic about which other component reads/writes it.
 */
export interface PendingInboundEntry {
    message: Message;
    conversation: Conversation;
}
//# sourceMappingURL=pending-inbound.d.ts.map
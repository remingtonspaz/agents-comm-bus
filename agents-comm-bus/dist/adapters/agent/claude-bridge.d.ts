/**
 * ClaudeBridge — Claude-side of the agents-comm-bus daemon.
 *
 * Hosts the `claude_*` IPC methods, the inline-keyboard label choices
 * specific to Claude's permission / question UX, the wake-on-resolve write
 * path (`permission-response.json` + `trigger-enter`), and the per-comm
 * callback handler. The daemon constructs one ClaudeBridge and asks it to
 * `attach` to the bus + the running comm adapters; everything Claude-specific
 * stays inside this module.
 */
import { type CommAdapter, type Conversation, type Message, type QueryId, type Storage } from "../../../../agents-comm-bus-core/dist/index.js";
import type { MessageBus } from "../../bus.js";
export interface PendingInboundEntry {
    message: Message;
    conversation: Conversation;
}
export interface ClaudeBridgeOptions {
    storage: Storage;
    bus: MessageBus;
    /**
     * Shared inbound queue that Claude's `claude_drain_inbound` IPC method
     * pulls from. The daemon owns the array reference so other consumers
     * (e.g. the Telegram MCP shim's `telegram_check_messages`) can drain
     * from the same queue.
     */
    pendingInbound: PendingInboundEntry[];
    /** Max queue depth before old entries are dropped. */
    pendingInboundMax?: number;
}
/**
 * Outcome shape returned by claude_register_session.
 */
export interface RegisterSessionResult {
    ok: boolean;
    reason?: string;
    wake_dir?: string;
}
/**
 * Outcome shape returned by claude_open_query.
 */
export interface OpenQueryResult {
    query_id: QueryId;
    hook_response: unknown;
    hookJson: unknown;
    nativeHookJson: unknown;
}
export declare class ClaudeBridge {
    private readonly options;
    private readonly wake;
    private readonly pendingInboundMax;
    constructor(options: ClaudeBridgeOptions);
    /**
     * Wire Claude-specific behaviors into the bus and each comm adapter.
     * Must be called after the bus is constructed but before `bus.start()`.
     */
    attach(comms: CommAdapter[]): void;
    /**
     * Drain entries from the pending-inbound queue. Used by both
     * `claude_drain_inbound` (which also updates the session's most-recent
     * inbound) and the Telegram MCP shim's `telegram_check_messages`.
     */
    drainPendingInbound(): PendingInboundEntry[];
    registerSession(params: Record<string, unknown>, socket?: {
        once(event: "close", handler: () => void): void;
    }): Promise<RegisterSessionResult>;
    drainInbound(params: Record<string, unknown>): Promise<PendingInboundEntry[]>;
    openQuery(params: Record<string, unknown>): Promise<OpenQueryResult>;
    private handleCommCallback;
}
//# sourceMappingURL=claude-bridge.d.ts.map
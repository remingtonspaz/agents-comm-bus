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
import { type AgentId, type CommAdapter, type Conversation, type QueryId, type Storage } from "../../../../../agents-comm-bus-core/dist/index.js";
import type { MessageBus } from "../../../bus.js";
import type { AgentBridge, AgentBridgeContext, AgentBridgeFactory } from "../../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../../runtime/pending-inbound.js";
export type { PendingInboundEntry } from "../../../runtime/pending-inbound.js";
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
export declare class ClaudeBridge implements AgentBridge {
    private readonly options;
    readonly agentId: AgentId;
    readonly ipcMethods: ReadonlySet<string>;
    private readonly wake;
    private ownedAccountsCache;
    constructor(options: ClaudeBridgeOptions);
    /**
     * Wire Claude-specific behaviors into the bus + per-comm callbacks. The
     * shared dispatch sink (pendingInbound + onInboundConversation fan-out)
     * is set up by the daemon; here we only own resolve-on-sink (write the
     * wake response) and the inline-keyboard callback handler.
     */
    attach(comms: CommAdapter[]): void;
    onInboundConversation(conversation: Conversation): Promise<void>;
    handleIpcMethod(method: string, params: Record<string, unknown>, ctx: {
        socket?: {
            once(event: "close", handler: () => void): void;
        };
    }): Promise<unknown>;
    /**
     * Drain pending-inbound entries whose source `(comm, account)` belongs to
     * a Claude registration. The queue is daemon-wide and shared across
     * bridges, so each agent must filter to its own accounts — otherwise the
     * first bridge to drain sweeps the queue and starves the others. We
     * filter on `message.chat.account` (the bot_user_id) rather than the
     * derived `conversation.agent` so the check is rooted in the source
     * record contract: `(comm, bot_user_id)` uniquely identifies a
     * `(project, agent)` registration per the daemon design.
     */
    drainPendingInbound(): Promise<PendingInboundEntry[]>;
    /**
     * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. The
     * daemon's account registrations only change via the CLI, which requires
     * a daemon restart to take effect — so caching once per process is safe.
     * Future-proofing for runtime registration would re-fetch on miss; left
     * as a follow-up.
     */
    private ownedAccountKeys;
    registerSession(params: Record<string, unknown>, socket?: {
        once(event: "close", handler: () => void): void;
    }): Promise<RegisterSessionResult>;
    drainInbound(params: Record<string, unknown>): Promise<PendingInboundEntry[]>;
    openQuery(params: Record<string, unknown>): Promise<OpenQueryResult>;
    private handleCommCallback;
    private chatRefForConversation;
}
export declare class ClaudeBridgeFactory implements AgentBridgeFactory {
    readonly agentId: AgentId;
    create(context: AgentBridgeContext): AgentBridge;
}
//# sourceMappingURL=bridge.d.ts.map
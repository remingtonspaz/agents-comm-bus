import type { AgentId, CommAdapter, Conversation, Storage } from "../../../agents-comm-bus-core/dist/index.js";
import type { MessageBus } from "../bus.js";
import type { PendingInboundEntry } from "./pending-inbound.js";
export interface AgentBridgeContext {
    storage: Storage;
    bus: MessageBus;
    pendingInbound: PendingInboundEntry[];
}
export interface AgentBridge {
    /** Agent id this bridge handles (e.g. `"claude"`). */
    readonly agentId: AgentId;
    /**
     * IPC method names this bridge handles. The daemon's dispatcher matches
     * the incoming `request.method` against this set; first hit wins.
     * Convention: include a stable agent prefix (e.g. `claude_register_session`)
     * so multiple bridges can coexist without collision.
     */
    readonly ipcMethods: ReadonlySet<string>;
    /** Wire dispatch / resolve sinks + per-comm callback handlers onto the bus. */
    attach(comms: CommAdapter[]): void;
    /**
     * Optional: notification that a fresh inbound conversation just landed.
     * Bridges can use this to wake the agent (e.g. ClaudeBridge writes a
     * `trigger-enter` file).
     */
    onInboundConversation?(conversation: Conversation): Promise<void>;
    /** Handle an IPC method that this bridge advertised in `ipcMethods`. */
    handleIpcMethod(method: string, params: Record<string, unknown>, ctx: {
        socket?: {
            once(event: "close", handler: () => void): void;
        };
    }): Promise<unknown>;
}
export interface AgentBridgeFactory {
    readonly agentId: AgentId;
    create(context: AgentBridgeContext): AgentBridge;
}
//# sourceMappingURL=agent-bridge.d.ts.map
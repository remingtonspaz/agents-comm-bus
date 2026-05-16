import { type AgentId, type CommAdapter, type Conversation, type QueryId, type Storage } from "../../../../../agents-comm-bus-core/dist/index.js";
import type { MessageBus } from "../../../bus.js";
import type { AgentBridge, AgentBridgeContext, AgentBridgeFactory } from "../../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../../runtime/pending-inbound.js";
import { CodexAgentAdapter } from "./adapter.js";
export interface CodexBridgeOptions {
    storage: Storage;
    bus: MessageBus;
    pendingInbound: PendingInboundEntry[];
    defaultAppServerUrl?: string;
    queryPollTimeoutMs?: number;
}
export interface RegisterCodexSessionResult {
    ok: boolean;
    reason?: string;
    capabilities?: CodexAgentAdapter["capabilities"];
}
export interface CodexOpenQueryResult {
    query_id: QueryId;
    hook_response: unknown;
    hookJson: unknown;
    nativeHookJson: unknown;
}
export declare class CodexBridge implements AgentBridge {
    private readonly options;
    readonly agentId: AgentId;
    readonly ipcMethods: ReadonlySet<string>;
    private readonly adapter;
    private readonly waiters;
    private readonly sessionsByProject;
    constructor(options: CodexBridgeOptions);
    attach(comms: CommAdapter[]): void;
    onInboundConversation(conversation: Conversation): Promise<void>;
    handleIpcMethod(method: string, params: Record<string, unknown>, ctx: {
        socket?: {
            once(event: "close", handler: () => void): void;
        };
    }): Promise<unknown>;
    registerSession(params: Record<string, unknown>, socket?: {
        once(event: "close", handler: () => void): void;
    }): Promise<RegisterCodexSessionResult>;
    drainInbound(params: Record<string, unknown>): Promise<PendingInboundEntry[]>;
    openQuery(params: Record<string, unknown>): Promise<CodexOpenQueryResult>;
    turnControl(params: Record<string, unknown>): Promise<unknown>;
    private handleCommCallback;
    private waitForResolution;
    private trackSession;
    private untrackSession;
}
export declare class CodexBridgeFactory implements AgentBridgeFactory {
    readonly agentId: AgentId;
    create(context: AgentBridgeContext): AgentBridge;
}
//# sourceMappingURL=bridge.d.ts.map
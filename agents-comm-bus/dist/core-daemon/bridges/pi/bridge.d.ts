/**
 * PiBridge — Pi-side of the agents-comm-bus daemon.
 *
 * Hosts the `pi_*` IPC methods, Pi-scoped inbound draining, and explicit lease
 * release. Pi has no wake watcher (the extension polls + injects itself), so
 * this bridge is simpler than Claude/Codex.
 */
import { type AgentId, type AuditStore, type CommAdapter, type SessionId, type Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../../bus.js";
import type { AgentBridge, AgentBridgeContext, AgentBridgeFactory, DaemonSelfIdentity, EnsureCommsForSession } from "../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../runtime/pending-inbound.js";
import { type SessionOwnerLiveness } from "../../runtime/session-owner-liveness.js";
export interface PiBridgeOptions {
    storage: Storage;
    bus: MessageBus;
    audit?: AuditStore;
    pendingInbound: PendingInboundEntry[];
    ensureCommsForSession?: EnsureCommsForSession;
    /** AGE-58: daemon-resolved identity for session ownership stamping. */
    daemonOwner?: DaemonSelfIdentity;
    /** AGE-81: injectable durable-owner liveness for scoped sibling precedence. */
    sessionOwnerIsLive?: SessionOwnerLiveness;
}
export interface RegisterPiSessionResult {
    ok: boolean;
    reason?: string;
    session?: SessionId;
    project?: string;
    agent?: AgentId;
}
export declare class PiBridge implements AgentBridge {
    private readonly options;
    readonly agentId: AgentId;
    readonly ipcMethods: ReadonlySet<string>;
    private readonly sessionOwnerIsLive;
    constructor(options: PiBridgeOptions);
    attach(_comms: CommAdapter[]): void;
    handleIpcMethod(method: string, params: Record<string, unknown>, ctx: {
        socket?: {
            once(event: "close", handler: () => void): void;
        };
    }): Promise<unknown>;
    private ensureCommsBestEffort;
    private ownedAccountKeys;
    private assertCallerProjectMatchesStored;
    registerSession(params: Record<string, unknown>, socket?: {
        once(event: "close", handler: () => void): void;
    }): Promise<RegisterPiSessionResult>;
    drainInbound(params: Record<string, unknown>): Promise<{
        messages: PendingInboundEntry[];
    }>;
    unregisterSession(params: Record<string, unknown>): Promise<{
        ok: true;
    }>;
}
export declare class PiBridgeFactory implements AgentBridgeFactory {
    readonly agentId: AgentId;
    create(context: AgentBridgeContext): AgentBridge;
}
//# sourceMappingURL=bridge.d.ts.map
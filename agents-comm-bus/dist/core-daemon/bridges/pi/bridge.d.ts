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
    requestScopeReconcile?: () => void;
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
    /**
     * AGE-91: Pi is route-ready by construction once a session is registered.
     *
     * This is NOT a stub. Pi has no wake route and no `onInboundConversation`
     * because its delivery is **pull-based**: the extension polls
     * `pi_drain_inbound` with its own session id, so the drain IS the delivery.
     * There is no daemon-local route object to check, and reporting `false`
     * would wrongly tell a caller that a live, polling Pi session cannot be
     * reached. Do not "fix" this by inventing a route check.
     */
    routeReady(_session: SessionId): boolean;
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
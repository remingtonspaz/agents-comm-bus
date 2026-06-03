import { type AccountId, type AgentId, type AuditStore, type CommAdapter, type CommId, type Conversation, type QueryId, type Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../../bus.js";
import type { AgentBridge, AgentBridgeContext, AgentBridgeFactory, EnsureCommsForSession } from "../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../runtime/pending-inbound.js";
import { CodexAgentAdapter, type CodexAgentAdapterOptions } from "./adapter.js";
export interface CodexBridgeOptions {
    storage: Storage;
    bus: MessageBus;
    audit?: AuditStore;
    pendingInbound: PendingInboundEntry[];
    defaultAppServerUrl?: string;
    appServerClientFactory?: CodexAgentAdapterOptions["appServerClientFactory"];
    queryPollTimeoutMs?: number;
    appServerCleanupDelayMs?: number;
    sessionOwnerCheckIntervalMs?: number;
    isProcessAlive?: (pid: number) => boolean;
    /**
     * AGE-38: lazy, session-triggered comm-adapter instantiation on register.
     * Optional so tests can construct the bridge directly; the daemon's
     * composition root always supplies it.
     */
    ensureCommsForSession?: EnsureCommsForSession;
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
export interface CodexBootstrapStatusResult {
    ok: true;
    has_account_registration: boolean;
    registration_count: number;
    managed_app_server_present: boolean;
    bootstrap_required: boolean;
    reason: string;
}
export declare class CodexBridge implements AgentBridge {
    private readonly options;
    readonly agentId: AgentId;
    readonly ipcMethods: ReadonlySet<string>;
    private readonly adapter;
    private readonly waiters;
    private readonly sessionsByProject;
    private readonly activeLeases;
    private ownedAccountsCache;
    private ownerCheckTimer;
    constructor(options: CodexBridgeOptions);
    attach(comms: CommAdapter[]): void;
    attachComm(comm: CommAdapter): void;
    detachComm(_commId: CommId, _accountId: AccountId): void;
    invalidateRegistrationCaches(): void;
    onInboundConversation(conversation: Conversation): Promise<void>;
    handleIpcMethod(method: string, params: Record<string, unknown>, ctx: {
        socket?: {
            once(event: "close", handler: () => void): void;
        };
    }): Promise<unknown>;
    bootstrapStatus(params: Record<string, unknown>): Promise<CodexBootstrapStatusResult>;
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
    private releaseSessionLease;
    private ensureOwnerCheckTimer;
    private stopOwnerCheckTimerIfIdle;
    private releaseLeasesWithDeadOwners;
    private scheduleManagedAppServerCleanup;
    private cleanupManagedAppServerIfLeaseIsIdle;
    private chatRefForConversation;
    private auditWake;
    private pendingInboundForConversation;
    /**
     * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. See
     * the matching comment in `ClaudeBridge` for the caching contract.
     */
    private ownedAccountKeys;
    private removePendingInbound;
}
export declare class CodexBridgeFactory implements AgentBridgeFactory {
    readonly agentId: AgentId;
    create(context: AgentBridgeContext): AgentBridge;
}
//# sourceMappingURL=bridge.d.ts.map
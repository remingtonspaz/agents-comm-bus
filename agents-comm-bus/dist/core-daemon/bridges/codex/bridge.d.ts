import { type AccountId, type AgentId, type AuditStore, type CommAdapter, type CommId, type Conversation, type QueryId, type SessionId, type Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../../bus.js";
import type { AgentBridge, AgentBridgeContext, AgentBridgeFactory, DaemonSelfIdentity, EnsureCommsForSession, PersistHeldCommLeaseAgentProperties, ReadHeldCommLease, RetirementBlockerSnapshot } from "../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../runtime/pending-inbound.js";
import { CodexAgentAdapter, type CodexAgentAdapterOptions } from "./adapter.js";
import { type SessionOwnerLiveness } from "../../runtime/session-owner-liveness.js";
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
    /** AGE-58: daemon-resolved identity for session ownership stamping. */
    daemonOwner?: DaemonSelfIdentity;
    /** Injectable timers for deterministic tests (AGE-36 managed cleanup). */
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (handle: unknown) => void;
    /** AGE-81: injectable durable-owner liveness for scoped sibling precedence. */
    sessionOwnerIsLive?: SessionOwnerLiveness;
    /** AGE-100: on-disk comm-lock lookup for inbound wake target resolution. */
    readHeldCommLease?: ReadHeldCommLease;
    /** AGE-103: persist discovered wake targets onto a self-held comm lock. */
    persistHeldCommLeaseAgentProperties?: PersistHeldCommLeaseAgentProperties;
    /** AGE-103: loopback port scan range for cwd-probe fallback (default 4500..4600). */
    codexPortRange?: {
        min: number;
        max: number;
    };
    codexProbeTimeoutMs?: number;
    codexProbeConcurrency?: number;
    requestScopeReconcile?: () => void;
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
    private readonly sessionRoutes;
    private readonly activeLeases;
    private ownedAccountsCache;
    private ownerCheckTimer;
    /** AGE-36: scheduled / in-flight managed app-server cleanup counters. */
    private pendingManagedCleanups;
    private inFlightManagedCleanups;
    private readonly sessionOwnerIsLive;
    private readonly appServerClientFactory;
    /** AGE-103: single-flight cwd probe keyed by comm+bot+project. */
    private readonly inFlightCwdProbes;
    private readonly cwdProbeJoiners;
    constructor(options: CodexBridgeOptions);
    attach(comms: CommAdapter[]): void;
    attachComm(comm: CommAdapter): void;
    detachComm(_commId: CommId, _accountId: AccountId): void;
    invalidateRegistrationCaches(): void;
    getRetirementBlockers(): RetirementBlockerSnapshot | null;
    onInboundConversation(conversation: Conversation): Promise<void>;
    private wakeWithResolvedTarget;
    private tryProbeFallbackWake;
    private getOrCreateCwdProbe;
    private auditProbePersistFailure;
    private auditProbeTargetValidationFailure;
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
    private clearWaiter;
    private resolveInboundWakeTargetFromCommLock;
    private auditInboundWakeTargetFailure;
    private applyRegistrationTargets;
    private ensureCommsBestEffort;
    /** AGE-91: daemon-local route = a tracked app-server route for this session. */
    routeReady(sessionId: SessionId): boolean;
    private isLocallyDeliverable;
    /**
     * AGE-90: after a deliverability edge with confirmed rehydration, wake once
     * via the newest in-scope pending row. `pendingInboundForConversation`
     * aggregates every owned-account entry in the project for one steer attempt.
     */
    private redrivePendingInbound;
    private trackSession;
    private untrackSession;
    private resolveSessionForConversation;
    private releaseSessionLease;
    private ensureOwnerCheckTimer;
    private stopOwnerCheckTimerIfIdle;
    private releaseLeasesWithDeadOwners;
    private releaseDeadSameProjectLease;
    private scheduleManagedAppServerCleanup;
    private cleanupManagedAppServerIfLeaseIsIdle;
    private chatRefForConversation;
    private auditWake;
    private auditWakeFailure;
    private pendingInboundForConversation;
    /**
     * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. See
     * the matching comment in `ClaudeBridge` for the caching contract.
     */
    private ownedAccountKeys;
    private removePendingInbound;
}
export interface CodexBridgeFactoryOptions {
    codexPortRange?: {
        min: number;
        max: number;
    };
    codexProbeTimeoutMs?: number;
    codexProbeConcurrency?: number;
}
export declare class CodexBridgeFactory implements AgentBridgeFactory {
    private readonly factoryOptions;
    readonly agentId: AgentId;
    constructor(factoryOptions?: CodexBridgeFactoryOptions);
    create(context: AgentBridgeContext): AgentBridge;
}
//# sourceMappingURL=bridge.d.ts.map
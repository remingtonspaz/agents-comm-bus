import type { AccountId, AgentId, AuditStore, CommAdapter, CommId, Conversation, Message, SessionId, Storage } from "agents-comm-bus-core";
import type { SessionLeaseOwner } from "agents-comm-bus-core/storage/storage";
import type { MessageBus } from "../bus.js";
import type { AgentLeaseProperties, ReadHeldCommLease } from "./comm-lease.js";
export type { AgentLeaseProperties, HeldCommLeaseLookupResult, ReadHeldCommLease, } from "./comm-lease.js";
import type { PendingInboundEntry } from "./pending-inbound.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
/** Daemon-local retirement blockers: stable reason key → count (AGE-36). */
export type RetirementBlockerSnapshot = Readonly<Record<string, number>>;
export type EnsureCommsForSessionOptions = {
    /** Canonical serialized account_label_scope JSON, or null when unscoped. */
    accountLabelScope?: string | null;
    /** Optional agent metadata to stamp onto comm-resource leases (AGE-100). */
    agentLeaseProperties?: AgentLeaseProperties;
};
/** Outcome of the daemon ensure-comms path (AGE-89 rehydration signal). */
export type EnsureCommsForSessionResult = {
    /** True when durable pending-inbound rehydration completed for this scope. */
    rehydrated: boolean;
    /** AGE-97: per-registration outcomes from the ensure loop (empty when none attempted). */
    outcomes: EnsureRegistrationResult[];
};
export type EnsureRegistrationRetryClass = "permanent" | "transient" | "success";
export type EnsureRegistrationResult = {
    status: "started";
    registration_id: string;
    comm: CommId;
    account_id: string;
    retryClass: "success";
} | {
    status: "already-live";
    registration_id: string;
    comm: CommId;
    account_id: string;
    retryClass: "success";
} | {
    status: "in-flight";
    registration_id: string;
    comm: CommId;
    account_id: string;
    retryClass: "success";
} | {
    status: "no-factory";
    registration_id: string;
    comm: CommId;
    account_id: string;
    rescanned: boolean;
    retryClass: "permanent";
    reason: string;
} | {
    status: "invalid-credentials";
    registration_id: string;
    comm: CommId;
    account_id: string;
    reason: string;
    retryClass: "permanent";
    resolution: import("./credential-resolution.js").CredentialResolution;
} | {
    status: "construction-failed";
    registration_id: string;
    comm: CommId;
    account_id: string;
    reason: string;
    retryClass: "transient";
} | {
    status: "start-failed";
    registration_id: string;
    comm: CommId;
    account_id: string;
    reason: string;
    retryClass: "transient";
    resolution: import("./credential-resolution.js").CredentialResolution;
};
/**
 * Lazily bring up the comm adapters a `(project, agent)` session needs, on
 * session entry. AGE-38: the daemon no longer eager-loads every registered bot
 * at startup; instead a bridge calls this from its register-session handler so
 * the daemon instantiates (and leases) only the bots its live sessions use.
 * Idempotent — safe to call on every register (hooks register frequently).
 */
export type EnsureCommsForSession = (project: string, agent: AgentId, options?: EnsureCommsForSessionOptions) => Promise<EnsureCommsForSessionResult>;
/** Resolved daemon self-identity; stamped onto sessions at lease acquire (AGE-58). */
export interface DaemonSelfIdentity {
    discoveryRoot: string;
    checkoutRoot: string | null;
    stateRoot: string;
    daemonBin: string | null;
    authorityRank: string;
}
export interface AgentBridgeContext {
    storage: Storage;
    bus: MessageBus;
    audit: AuditStore;
    pendingInbound: PendingInboundEntry[];
    /** AGE-38: lazy, session-triggered comm-adapter instantiation. */
    ensureCommsForSession: EnsureCommsForSession;
    /** AGE-58: daemon-resolved identity for session ownership stamping. */
    daemonOwner: DaemonSelfIdentity;
    /** AGE-81: live connection or recent, still-running durable owner process. */
    sessionOwnerIsLive: SessionOwnerLiveness;
    /** AGE-100: read the on-disk comm lock when held by this daemon. */
    readHeldCommLease: ReadHeldCommLease;
    /** AGE-101: hint explicit session exit for early lazy-scope reconcile. */
    requestScopeReconcile?: () => void;
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
     * Optional: wire per-comm state (e.g. `onCallback` handlers) for a newly
     * attached comm adapter. Called by the daemon's hot-reload path after a
     * new `account_registrations` row is picked up. Bridges that do per-comm
     * wiring in `attach()` should factor that wiring out and reuse it here so
     * the initial boot and reload paths produce equivalent state.
     */
    attachComm?(comm: CommAdapter): void;
    /**
     * Optional: clean up per-comm state when an adapter is detached at
     * runtime (e.g. its `account_registrations` row was removed via the
     * CLI). The adapter itself is stopped by the daemon's reload path; this
     * is for bridge-internal references that key on the adapter.
     */
    detachComm?(commId: CommId, accountId: AccountId): void;
    /**
     * Optional: invalidate caches whose contents depend on the current set
     * of `account_registrations` (e.g. owned bot ids). Called by the daemon
     * after any reload so the next drain rebuilds the cache.
     */
    invalidateRegistrationCaches?(): void;
    /**
     * AGE-91: is there a daemon-local delivery route for this session?
     *
     * This is the per-host half of deliverability — the daemon composes it with
     * the canonical owner-liveness predicate. It reports only whether THIS daemon
     * holds a route object for the session; whether the far end answers is a wake
     * outcome, not a deliverability fact.
     *
     * Bridges whose delivery is pull-based (the agent polls) have no route object
     * and are route-ready by construction once registered.
     */
    routeReady?(session: SessionId): boolean;
    /**
     * Optional: notification that a fresh inbound conversation just landed.
     * Bridges can use this to wake the agent (e.g. ClaudeBridge writes a
     * `trigger-enter` file). `message` is the inbound message that triggered
     * the dispatch — ClaudeBridge uses its text as the verbatim wake seed
     * (AGE-65). Optional so existing bridges can ignore it.
     *
     * AGE-94: the daemon guarantees `conversation.agent === this.agentId` at call
     * time — the dispatch loop applies a central ownership default-deny before
     * invoking this hook, so a bridge is never handed a foreign-agent
     * conversation here. There is no additive all-inbound bridge observer today:
     * the daemon owns the single dispatch sink (`setDispatchSink` REPLACES, it
     * does not fan out), so a bridge must not reach for it. Cross-agent
     * observation is separate design work. The bridge-local guard is kept as
     * defense-in-depth, not because the contract permits foreign delivery.
     */
    onInboundConversation?(conversation: Conversation, message?: Message): Promise<void>;
    /** Handle an IPC method that this bridge advertised in `ipcMethods`. */
    handleIpcMethod(method: string, params: Record<string, unknown>, ctx: {
        socket?: {
            once(event: "close", handler: () => void): void;
        };
    }): Promise<unknown>;
    /**
     * Optional (AGE-36): daemon-local retirement blockers. Absent or null means no
     * blocker from this bridge. Must not consult the shared DB for global counts.
     */
    getRetirementBlockers?(): RetirementBlockerSnapshot | null;
}
export interface AgentBridgeFactory {
    readonly agentId: AgentId;
    create(context: AgentBridgeContext): AgentBridge;
}
/** Merge hook-supplied process owner with daemon-resolved identity (AGE-58). */
export declare function sessionLeaseOwnerWithDaemon(ownerFromParams: {
    process_pid: number | null;
    process_label?: string | null;
    process_start_time?: number | null;
} | undefined, daemonOwner: DaemonSelfIdentity): SessionLeaseOwner;
//# sourceMappingURL=agent-bridge.d.ts.map
import type { AccountRegistration, AgentId, Session, Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../bus.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommLeaseArbiter } from "./comm-lease.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
import { type removeLiveAdapter } from "./comm-adapter-lifecycle.js";
/** Grace before lazy adapters are stopped when a scope has zero live sessions. */
export declare const DEFAULT_SCOPE_RELEASE_GRACE_MS = 30000;
export interface ScopeReleaseReconcileCounts {
    scopes_zero_live: number;
    scopes_released: number;
    adapters_removed: number;
    active_scopes_pruned: number;
}
export interface ScopeReleaseReconcileState {
    zeroLiveSince: Map<string, number>;
    graceTimers?: Map<string, unknown>;
}
export declare function scopeKey(agent: AgentId | string, project: string, accountLabelScope?: string | null): string;
export declare function isRegistrationScopeActive(registration: AccountRegistration, activeScopes: ReadonlySet<string>): boolean;
/**
 * Union of lazy+eager registrations desired by every live LOCAL session scope
 * plus all eager standing registrations.
 */
export declare function buildGlobalDesiredRegistrationIds(input: {
    storage: Storage;
    factories: CommAdapterFactory[];
    discoveryRoot: string;
    sessionOwnerIsLive: SessionOwnerLiveness;
    allRegistrations?: AccountRegistration[];
    activeSessions?: readonly Session[];
}): Promise<Set<string>>;
/**
 * AGE-101: reconcile lazy adapters when durable live-session truth shows zero
 * local owners for an active scope. Reuses the reload removal path via removeLiveAdapter.
 */
export declare function reconcileLazyAdapterScopes(input: {
    storage: Storage;
    bus: MessageBus;
    bridges: AgentBridge[];
    factories: CommAdapterFactory[];
    activeScopes: Set<string>;
    leaseArbiter: CommLeaseArbiter;
    sessionOwnerIsLive: SessionOwnerLiveness;
    removeAdapter: typeof removeLiveAdapter;
    state: ScopeReleaseReconcileState;
    discoveryRoot: string;
    graceMs?: number;
    now?: () => number;
    scheduleGraceExpiry?: (key: string, delayMs: number) => void;
    cancelGraceExpiry?: (key: string) => void;
}): Promise<ScopeReleaseReconcileCounts>;
export declare function liveAdapterKeys(bus: MessageBus): Set<string>;
//# sourceMappingURL=scope-release-reconcile.d.ts.map
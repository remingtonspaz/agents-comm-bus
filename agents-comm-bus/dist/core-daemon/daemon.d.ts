import { type AccountId, type AgentId, type CommId, type Storage } from "agents-comm-bus-core";
import { CommLeaseArbiter, type AgentLeaseProperties } from "./runtime/comm-lease.js";
import { MessageBus } from "./bus.js";
import { openSqliteStorage } from "./storage/sqlite.js";
import { JsonlAuditStore } from "./storage/audit.js";
import { ContentAddressedBlobStore } from "./storage/blobs.js";
import type { AgentBridge, AgentBridgeFactory, EnsureCommsForSession, EnsureRegistrationResult } from "./runtime/agent-bridge.js";
import type { CommAdapterFactory } from "./runtime/comm-factory.js";
import { type EnsureRegistrationContext } from "./runtime/ensure-registration.js";
import type { PendingInboundEntry } from "./runtime/pending-inbound.js";
export type { AgentBridge, AgentBridgeFactory, AgentBridgeContext, } from "./runtime/agent-bridge.js";
export type { CommAdapterFactory, CommAdapterFactoryEnv, CommIpcDeps, } from "./runtime/comm-factory.js";
export type { IpcMethodHandler } from "./runtime/ipc-method.js";
export type { PendingInboundEntry } from "./runtime/pending-inbound.js";
export interface RunDaemonOptions {
    /**
     * Comm-side factories to load adapters from. Each factory is consulted
     * against any matching `account_registrations` rows; missing creds skip
     * the row with a warning.
     */
    commAdapterFactories: CommAdapterFactory[];
    /**
     * Directory scanned on-demand when a session needs a comm factory that was
     * not present at daemon startup (AGE-49 hot factory reload).
     */
    adaptersDir?: string;
    /**
     * Re-runs the comm adapter loader against `adaptersDir`. When omitted, no
     * on-demand factory discovery is available (direct/test callers).
     */
    loadCommAdapterFactories?: () => Promise<CommAdapterFactory[]>;
    /**
     * Agent-side bridge factories. Each bridge is constructed with shared
     * runtime deps (storage, bus, pendingInbound) and asked to `attach` to
     * the live comm adapters before the bus starts.
     */
    agentBridgeFactories: AgentBridgeFactory[];
    /** Override `process.argv.slice(2)`. */
    argv?: string[];
    /** Override `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Override the path resolver's state-root selection. */
    stateRoot?: string;
    /** Override the runtime discovery-root selection (pid/port/spawn-lock only). */
    discoveryRoot?: string;
}
/**
 * Generic daemon entry point. Knows nothing about specific agents or
 * comms — adapter wiring is supplied by the composition root.
 *
 * Layout:
 *   1. Resolve filesystem paths, open storage / transcript / audit / blob stores.
 *   2. For each comm factory, load matching `account_registrations`, resolve
 *      credentials, instantiate one adapter per registration, dedup by bot id.
 *   3. Construct the bus.
 *   4. For each agent bridge factory, construct the bridge with shared deps
 *      and ask it to attach to the live comms.
 *   5. Index IPC methods (bridges contribute `claude_*`-style methods;
 *      comm factories contribute their MCP-tool surface) into a single
 *      dispatcher map.
 *   6. Start the IPC server, write the discovery files, start the bus
 *      (which starts the comm pollers).
 */
export declare function runDaemon(options: RunDaemonOptions): Promise<void>;
export { addAdapterForRegistration } from "./runtime/comm-adapter-lifecycle.js";
/**
 * AGE-38: instantiate (and lease) only the comm adapters a `(project, agent)`
 * session needs, lazily on session entry. Uses the per-registration primitive
 * (AGE-97) for each row in the session scope — never scope-wide over-activation.
 */
export declare function ensureCommsForSession(input: {
    project: string;
    /** Raw project from the client, for near-miss diagnostics when it differs. */
    requestedProject?: string;
    agent: AgentId;
    /** AGE-72: canonical serialized scope JSON, or null when unscoped. */
    accountLabelScope?: string | null;
    /** AGE-100: optional agent metadata stamped onto comm-resource leases. */
    agentLeaseProperties?: AgentLeaseProperties;
    factories: CommAdapterFactory[];
    /**
     * AGE-49: on-demand factory discovery when `factories` has no entry for a
     * registration's comm. Fires only on a no-factory miss, never eagerly.
     */
    rescanFactories?: (comm: string) => Promise<CommAdapterFactory | undefined>;
    bus: MessageBus;
    bridges: AgentBridge[];
    storage: Storage;
    env: NodeJS.ProcessEnv;
    blobs: ContentAddressedBlobStore;
    stateRoot: string;
    leaseArbiter: CommLeaseArbiter;
    inFlight: Set<string>;
    audit?: JsonlAuditStore;
}): Promise<{
    outcomes: EnsureRegistrationResult[];
}>;
export interface ReloadSummary {
    ok: true;
    added: Array<{
        comm: CommId;
        account_id: AccountId;
    }>;
    removed: Array<{
        comm: CommId;
        account_id: AccountId;
    }>;
    /**
     * Adapters whose registration key is unchanged but whose runtime state was
     * refreshed. Allowlist diffs update in place; credential refreshes recreate
     * the adapter so same-bot token rotation takes effect without daemon restart.
     */
    updated: Array<{
        comm: CommId;
        account_id: AccountId;
        what: "allowlist" | "credentials";
    }>;
    skipped: Array<{
        comm: CommId;
        account_id?: string;
        reason: string;
    }>;
}
export interface ReloadOptions {
    forceCredentialRefresh?: Array<{
        comm: CommId | string;
        accountId: AccountId | string;
    }>;
    /** AGE-97: exact-registration ensure after DB writes (lazy→eager). */
    ensureRegistrationIds?: string[];
}
/**
 * Reconcile the live comm-adapter set with `account_registrations`. Called
 * from the `reload_registrations` IPC method after the CLI writes (or
 * deletes) a row. Diff is by `(commId, bot_user_id)`: rows that exist in
 * storage but not in the bus are constructed + started + attached to
 * bridges; adapters that exist in the bus but not in storage are detached
 * + stopped. Bridge registration caches are wiped at the end so the next
 * inbound drain sees the new ownership set.
 *
 * The reload is best-effort: a credential resolution failure or adapter
 * start failure surfaces in the `skipped` list and does not abort the
 * other diffs. Adapter `stop()` failures on remove are logged but do not
 * leave the bus in an inconsistent state — the adapter has already been
 * detached from the map.
 */
export declare function reloadAdapters(input: {
    factories: CommAdapterFactory[];
    bridges: AgentBridge[];
    bus: MessageBus;
    storage: Awaited<ReturnType<typeof openSqliteStorage>>;
    env: NodeJS.ProcessEnv;
    blobs: ContentAddressedBlobStore;
    stateRoot: string;
    leaseArbiter: CommLeaseArbiter;
    /**
     * AGE-38: the set of currently-active `(agent, project)` scopes (sessions
     * that registered this daemon-lifetime), keyed `${agent}:${project}`. Reload
     * hot-adds a registration whose scope is active even if it isn't live yet — so
     * `account-add` for a project the daemon is actively serving takes effect
     * immediately, while rows for inactive projects stay lazy.
     */
    activeScopes?: ReadonlySet<string>;
    audit?: JsonlAuditStore;
    /** AGE-97: exact-registration ensure for activation flag updates. */
    ensureRegistrationContext?: EnsureRegistrationContext;
    options?: ReloadOptions;
}): Promise<ReloadSummary>;
/**
 * Drain the shared `pendingInbound` queue, optionally scoped to one comm.
 *
 * When `params.comm` is a non-empty string, only entries whose
 * `message.chat.comm` matches that filter are spliced out and returned;
 * entries for other comms stay in the queue. This is the correct shape for
 * multi-comm setups — without scoped removal, a `{ comm: "matrix" }` call
 * would destructively drain ALL comms and the caller would merely filter
 * client-side, losing the other comms' pending entries as collateral.
 *
 * When `ownedAccountKeys` is supplied (a Set of `${comm}:${account}` keys),
 * the drain is additionally scoped to those accounts â€” only entries the caller
 * actually owns are removed. This is essential in a multi-bot setup where two
 * agents share a comm (Claude + Codex both on telegram with different bot
 * accounts): without account scoping a `comm_check_messages` from one agent
 * destructively drains the OTHER agent's pending inbound as collateral, so the
 * other agent's wake-driven drain then finds an empty queue and never injects
 * the message. An empty Set drains nothing.
 *
 * When neither `comm` nor `ownedAccountKeys` is supplied, the behavior is the
 * historical global drain: the entire queue is spliced (internal/legacy callers
 * without a session).
 *
 * Returned entries preserve queue order (oldest first).
 */
export declare function drainPendingInbound(queue: PendingInboundEntry[], params?: Record<string, unknown> | undefined): PendingInboundEntry[];
export interface DaemonStatusSummary {
    daemon_version: string;
    live_adapters: string[];
    pending_inbound_depth: number;
    active_scope_count: number;
}
export declare function handleDaemonStatus(input: {
    bus: MessageBus;
    pendingInbound: PendingInboundEntry[];
    activeScopes: ReadonlySet<string>;
}): DaemonStatusSummary;
export declare function handleEnsureCommsForScope(params: Record<string, unknown>, ensureCommsForSession: EnsureCommsForSession): Promise<{
    ok: true;
    project: string;
    agent: AgentId;
}>;
export declare function probeCommIdentity(params: Record<string, unknown>, factories: CommAdapterFactory[], env: NodeJS.ProcessEnv, rescanFactories?: (comm: string) => Promise<CommAdapterFactory | undefined>): Promise<{
    comm: CommId;
    account_id: string;
    account_username?: string | null;
}>;
//# sourceMappingURL=daemon.d.ts.map
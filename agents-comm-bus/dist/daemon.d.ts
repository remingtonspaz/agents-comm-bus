import { type AccountId, type CommId } from "../../agents-comm-bus-core/dist/index.js";
import { MessageBus } from "./bus.js";
import { openSqliteStorage } from "./storage/sqlite.js";
import { ContentAddressedBlobStore } from "./storage/blobs.js";
import type { AgentBridge, AgentBridgeFactory } from "./runtime/agent-bridge.js";
import type { CommAdapterFactory } from "./runtime/comm-factory.js";
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
}
/**
 * Generic daemon entry point. Knows nothing about specific agents or
 * comms — adapter wiring is supplied by the composition root.
 *
 * Layout:
 *   1. Resolve filesystem paths, open storage / transcript / audit / blob stores.
 *   2. For each comm factory, load matching `account_registrations`, resolve
 *      credentials, instantiate one adapter per registration, dedup by bot id,
 *      fall back to `factory.fallbackFromEnv` when no rows are registered.
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
     * Adapters whose registration is unchanged but whose runtime state was
     * refreshed in-place (e.g. allowlist set diff). The adapter instance and
     * its live polling are NOT recreated.
     */
    updated: Array<{
        comm: CommId;
        account_id: AccountId;
        what: "allowlist";
    }>;
    skipped: Array<{
        comm: CommId;
        account_id?: string;
        reason: string;
    }>;
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
 * When `comm` is omitted (or empty / non-string), the behavior is the
 * historical global drain: the entire queue is spliced.
 *
 * Returned entries preserve queue order (oldest first).
 */
export declare function drainPendingInbound(queue: PendingInboundEntry[], params?: Record<string, unknown> | undefined): PendingInboundEntry[];
//# sourceMappingURL=daemon.d.ts.map
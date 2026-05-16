import type { AgentBridgeFactory } from "./runtime/agent-bridge.js";
import type { CommAdapterFactory } from "./runtime/comm-factory.js";
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
//# sourceMappingURL=daemon.d.ts.map
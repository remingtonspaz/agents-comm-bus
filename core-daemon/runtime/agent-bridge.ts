import type {
  AccountId,
  AgentId,
  AuditStore,
  CommAdapter,
  CommId,
  Conversation,
  Storage,
} from "agents-comm-bus-core";

import type { MessageBus } from "../bus.js";
import type { IpcMethodHandler } from "./ipc-method.js";
import type { PendingInboundEntry } from "./pending-inbound.js";

export interface AgentBridgeContext {
  storage: Storage;
  bus: MessageBus;
  audit: AuditStore;
  pendingInbound: PendingInboundEntry[];
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
   * Optional: notification that a fresh inbound conversation just landed.
   * Bridges can use this to wake the agent (e.g. ClaudeBridge writes a
   * `trigger-enter` file).
   */
  onInboundConversation?(conversation: Conversation): Promise<void>;

  /** Handle an IPC method that this bridge advertised in `ipcMethods`. */
  handleIpcMethod(
    method: string,
    params: Record<string, unknown>,
    ctx: { socket?: { once(event: "close", handler: () => void): void } },
  ): Promise<unknown>;
}

export interface AgentBridgeFactory {
  readonly agentId: AgentId;
  create(context: AgentBridgeContext): AgentBridge;
}

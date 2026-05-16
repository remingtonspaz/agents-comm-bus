import type {
  AccountRegistration,
  CommAdapter,
  CommId,
} from "../../../agents-comm-bus-core/dist/index.js";

import type { MessageBus } from "../bus.js";
import type { Storage } from "../../../agents-comm-bus-core/dist/index.js";
import type { IpcMethodHandler } from "./ipc-method.js";
import type { PendingInboundEntry } from "./pending-inbound.js";

export interface CommAdapterFactoryEnv {
  /**
   * `process.env`-like map. Comm factories may use environment variables as
   * a legacy / dev-mode credentials fallback (e.g. `TELEGRAM_BOT_TOKEN`).
   */
  readonly [key: string]: string | undefined;
}

export interface CommAdapterFactory {
  /** Comm id this factory produces adapters for (e.g. `"telegram"`). */
  readonly commId: CommId;

  /**
   * Resolve credentials from a stored `account_registrations` row. Returns
   * `undefined` if the registration can't be resolved (e.g. env var missing,
   * file unreadable) — the daemon will log and skip the row.
   */
  resolveCredentials(
    registration: AccountRegistration,
    env: CommAdapterFactoryEnv,
  ): Promise<{ credentials: Record<string, unknown> } | undefined>;

  /**
   * Optional environment-only fallback used when no `account_registrations`
   * row is available (e.g. fresh dev install before `account-add`). Returning
   * `undefined` means "no fallback available."
   */
  fallbackFromEnv?(
    env: CommAdapterFactoryEnv,
  ): { credentials: Record<string, unknown> } | undefined;

  /** Construct an adapter instance from resolved credentials. */
  create(credentials: Record<string, unknown>): CommAdapter;

  /**
   * Optional MCP-tool / IPC method surface this comm contributes. The map's
   * keys are IPC method names (e.g. `"telegram_send"`); values are handlers
   * with a closure over the runtime deps the comm needs.
   */
  ipcMethods?(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}

export interface CommIpcDeps {
  bus: MessageBus;
  storage: Storage;
  pendingInbound: PendingInboundEntry[];
}

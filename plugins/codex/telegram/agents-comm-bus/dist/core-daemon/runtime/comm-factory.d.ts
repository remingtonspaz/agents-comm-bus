import type { AccountId, AccountRegistration, BlobStore, CommAdapter, CommId } from "agents-comm-bus-core";
import type { MessageBus } from "../bus.js";
import type { Storage } from "agents-comm-bus-core";
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
     *
     * The optional `context.storage` lets the factory query DB-backed
     * configuration (e.g. allowlist tables) at attach/reload time. Factories
     * that don't need storage should ignore the parameter.
     */
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv, context?: ResolveCredentialsContext): Promise<{
        credentials: Record<string, unknown>;
    } | undefined>;
    /**
     * Optional environment-only fallback used when no `account_registrations`
     * row is available (e.g. fresh dev install before `account-add`). The
     * factory is responsible for resolving the comm-native account id (e.g.
     * via Telegram's `getMe`) so the bus can key its adapter map by it.
     */
    fallbackFromEnv?(env: CommAdapterFactoryEnv): Promise<{
        credentials: Record<string, unknown>;
        accountId: AccountId;
    } | undefined>;
    /**
     * Construct an adapter instance. `accountId` is the comm-native account id
     * (e.g. Telegram `bot_user_id`) that this adapter is bound to. The bus
     * keys its adapter map by `(commId, accountId)` so a daemon can host
     * multiple bots of the same comm type concurrently.
     */
    create(credentials: Record<string, unknown>, accountId: AccountId, context?: CommAdapterCreateContext): CommAdapter;
    /**
     * Optional MCP-tool / IPC method surface this comm contributes. The map's
     * keys are IPC method names (e.g. `"telegram_send"`); values are handlers
     * with a closure over the runtime deps the comm needs.
     */
    ipcMethods?(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
export interface CommAdapterCreateContext {
    blobs: BlobStore;
    stateRoot: string;
}
export interface ResolveCredentialsContext {
    storage?: Storage;
}
export interface CommIpcDeps {
    bus: MessageBus;
    storage: Storage;
    pendingInbound: PendingInboundEntry[];
}
//# sourceMappingURL=comm-factory.d.ts.map
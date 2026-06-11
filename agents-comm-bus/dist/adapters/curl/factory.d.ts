import type { AccountId, AccountRegistration, CommAdapter, CommId } from "agents-comm-bus-core";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
export declare const DEFAULT_CURL_ACCOUNT_ID = "curl:local";
export declare class CurlCommAdapterFactory implements CommAdapterFactory {
    readonly commId: CommId;
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv, context?: ResolveCredentialsContext): Promise<{
        credentials: Record<string, unknown>;
    } | undefined>;
    probeIdentity(credentials: Record<string, unknown>): Promise<{
        accountId: AccountId;
        accountUsername?: string | null;
    }>;
    create(credentials: Record<string, unknown>, accountId: AccountId, context?: CommAdapterCreateContext): CommAdapter;
    /**
     * Outbound IPC surface exists only to fail loudly: the generic MCP shim
     * maps `comm_send_message` → `curl_send`, and without these handlers a
     * misrouted send dies with a cryptic "unknown method" instead of the
     * inbound-only diagnostic the spec calls for.
     */
    ipcMethods(_deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
export declare function createCommAdapterFactory(): CommAdapterFactory;
//# sourceMappingURL=factory.d.ts.map
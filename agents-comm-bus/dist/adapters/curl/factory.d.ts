/**
 * Curl comm adapter factory (AGE-50).
 *
 * Credential resolution follows the daemon-owned `file:` token-ref pattern:
 * `account-add --comm curl --bot-token <secret>` writes `{ "botToken": ... }`
 * into the daemon state root and stores the file ref on the registration. The
 * token file may optionally carry a fixed `"port"`; otherwise the adapter
 * binds an ephemeral loopback port and publishes it via
 * `<stateRoot>/curl/<account>/endpoint.json`.
 *
 * Identity is synthetic — there is no remote bot API to probe. The default
 * account id is `curl:local`; an explicit id (for multi-scope setups) comes
 * through `account-add --account-id`.
 */
import type { AccountId, AccountRegistration, CommAdapter, CommId } from "agents-comm-bus-core";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../core-daemon/runtime/comm-factory.js";
import { type CredentialResolution } from "../../core-daemon/runtime/credential-resolution.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
export declare const DEFAULT_CURL_ACCOUNT_ID = "curl:local";
export declare class CurlCommAdapterFactory implements CommAdapterFactory {
    readonly commId: CommId;
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv, context?: ResolveCredentialsContext): Promise<CredentialResolution>;
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
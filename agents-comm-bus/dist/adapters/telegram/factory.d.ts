import type { AccountId, AccountRegistration, CommAdapter, CommId } from "agents-comm-bus-core";
import { type CredentialResolution } from "../../core-daemon/runtime/credential-resolution.js";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
export interface TelegramCredentials {
    botToken: string;
    allowedUserIds: string[];
}
export declare class TelegramCommAdapterFactory implements CommAdapterFactory {
    readonly commId: CommId;
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv, context?: ResolveCredentialsContext): Promise<CredentialResolution>;
    probeIdentity(credentials: Record<string, unknown>): Promise<{
        accountId: AccountId;
        accountUsername?: string | null;
    }>;
    create(credentials: Record<string, unknown>, accountId: AccountId, context?: CommAdapterCreateContext): CommAdapter;
    ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
export declare function createCommAdapterFactory(): CommAdapterFactory;
//# sourceMappingURL=factory.d.ts.map
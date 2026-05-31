import type { AccountId, AccountRegistration, CommAdapter, CommId } from "agents-comm-bus-core";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
export interface TelegramCredentials {
    botToken: string;
    allowedUserIds: string[];
}
export declare class TelegramCommAdapterFactory implements CommAdapterFactory {
    readonly commId: CommId;
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv, context?: ResolveCredentialsContext): Promise<{
        credentials: Record<string, unknown>;
    } | undefined>;
    fallbackFromEnv(env: CommAdapterFactoryEnv): Promise<{
        credentials: Record<string, unknown>;
        accountId: AccountId;
    } | undefined>;
    create(credentials: Record<string, unknown>, accountId: AccountId, context?: CommAdapterCreateContext): CommAdapter;
    ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
export declare function createCommAdapterFactory(): CommAdapterFactory;
//# sourceMappingURL=factory.d.ts.map
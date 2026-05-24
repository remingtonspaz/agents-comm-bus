import type { AccountId, AccountRegistration, CommAdapter, CommId } from "../../../../packages/core-contracts/dist/index.js";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../../runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../../runtime/ipc-method.js";
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
//# sourceMappingURL=factory.d.ts.map
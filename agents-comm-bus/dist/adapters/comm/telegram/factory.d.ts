import type { AccountRegistration, CommAdapter, CommId } from "../../../../../agents-comm-bus-core/dist/index.js";
import type { CommAdapterFactory, CommAdapterFactoryEnv, CommIpcDeps } from "../../../runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../../runtime/ipc-method.js";
export interface TelegramCredentials {
    botToken: string;
    allowedUserIds: string[];
}
export declare class TelegramCommAdapterFactory implements CommAdapterFactory {
    readonly commId: CommId;
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv): Promise<{
        credentials: Record<string, unknown>;
    } | undefined>;
    fallbackFromEnv(env: CommAdapterFactoryEnv): {
        credentials: Record<string, unknown>;
    } | undefined;
    create(credentials: Record<string, unknown>): CommAdapter;
    ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
//# sourceMappingURL=factory.d.ts.map
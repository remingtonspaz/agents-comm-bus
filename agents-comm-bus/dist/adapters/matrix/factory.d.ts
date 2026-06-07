import type { AccountId, AccountRegistration, CommAdapter, CommId } from "agents-comm-bus-core";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
import { type MatrixIdentityClient } from "./adapter.js";
export type EncryptedRoomPolicy = "decline";
export interface MatrixCredentials {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    deviceId?: string;
    allowedUserIds: string[];
    allowedRoomIds: string[];
    autoJoinInvites: boolean;
    encryptedRoomPolicy: EncryptedRoomPolicy;
}
export interface MatrixCommAdapterFactoryOptions {
    identityClient?: MatrixIdentityClient;
}
export declare class MatrixCommAdapterFactory implements CommAdapterFactory {
    private readonly options;
    readonly commId: CommId;
    constructor(options?: MatrixCommAdapterFactoryOptions);
    resolveCredentials(registration: AccountRegistration, env: CommAdapterFactoryEnv, context?: ResolveCredentialsContext): Promise<{
        credentials: Record<string, unknown>;
    } | undefined>;
    probeIdentity(credentials: Record<string, unknown>): Promise<{
        accountId: AccountId;
        accountUsername?: string | null;
    }>;
    create(credentials: Record<string, unknown>, accountId: AccountId, context?: CommAdapterCreateContext): CommAdapter;
    ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
export declare function createCommAdapterFactory(options?: MatrixCommAdapterFactoryOptions): CommAdapterFactory;
//# sourceMappingURL=factory.d.ts.map
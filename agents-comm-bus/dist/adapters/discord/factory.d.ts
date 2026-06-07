import type { AccountId, AccountRegistration, CommAdapter, CommId } from "agents-comm-bus-core";
import type { CommAdapterFactory, CommAdapterCreateContext, CommAdapterFactoryEnv, CommIpcDeps, ResolveCredentialsContext } from "../../core-daemon/runtime/comm-factory.js";
import type { IpcMethodHandler } from "../../core-daemon/runtime/ipc-method.js";
export interface DiscordCredentials {
    botToken: string;
    applicationId?: string;
    botUserId?: string;
}
export declare class DiscordCommAdapterFactory implements CommAdapterFactory {
    readonly commId: CommId;
    resolveCredentials(registration: AccountRegistration, _env: CommAdapterFactoryEnv, _context?: ResolveCredentialsContext): Promise<{
        credentials: Record<string, unknown>;
    } | undefined>;
    probeIdentity(credentials: Record<string, unknown>): Promise<{
        accountId: AccountId;
        accountUsername?: string | null;
    }>;
    create(credentials: Record<string, unknown>, accountId: AccountId, _context?: CommAdapterCreateContext): CommAdapter;
    ipcMethods(deps: CommIpcDeps): Map<string, IpcMethodHandler>;
}
export declare function createCommAdapterFactory(): CommAdapterFactory;
//# sourceMappingURL=factory.d.ts.map
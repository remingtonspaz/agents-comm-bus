import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommIpcDeps } from "./comm-factory.js";
import type { IpcMethodHandler } from "./ipc-method.js";
export interface CommFactoryRegistry {
    readonly factories: CommAdapterFactory[];
    rescanFactoriesForComm(comm: string): Promise<CommAdapterFactory | undefined>;
}
/**
 * Mutable comm-factory set with on-demand additive discovery. Initial factories
 * are registered at construction; `rescanFactoriesForComm` re-runs the loader
 * only when a live session needs a comm whose factory is not yet loaded.
 */
export declare function createCommFactoryRegistry(input: {
    initial: CommAdapterFactory[];
    loadFactories: () => Promise<CommAdapterFactory[]>;
    ipcMethods: Map<string, IpcMethodHandler>;
    ipcDeps: CommIpcDeps;
}): CommFactoryRegistry;
//# sourceMappingURL=comm-factory-registry.d.ts.map
import type { CommAdapterFactory, CommIpcDeps } from "./comm-factory.js";
import type { IpcMethodHandler } from "./ipc-method.js";
export declare class DuplicateCommIpcMethodError extends Error {
    readonly method: string;
    readonly existingCommId: string;
    readonly newCommId: string;
    constructor(method: string, existingCommId: string, newCommId: string);
}
/**
 * Register a comm factory's IPC handlers exactly once. Refuses to shadow an
 * existing method name from a different factory — callers must treat that as a
 * loud, fatal configuration error.
 */
export declare function registerCommIpcMethods(ipcMethods: Map<string, IpcMethodHandler>, factory: CommAdapterFactory, deps: CommIpcDeps, options?: {
    commIdByMethod?: Map<string, string>;
}): void;
//# sourceMappingURL=register-comm-ipc-methods.d.ts.map
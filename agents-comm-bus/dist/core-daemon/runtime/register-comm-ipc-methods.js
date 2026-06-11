export class DuplicateCommIpcMethodError extends Error {
    method;
    existingCommId;
    newCommId;
    constructor(method, existingCommId, newCommId) {
        super(`IPC method "${method}" is already registered for comm "${existingCommId}" ` +
            `(refusing duplicate registration from comm "${newCommId}")`);
        this.method = method;
        this.existingCommId = existingCommId;
        this.newCommId = newCommId;
        this.name = "DuplicateCommIpcMethodError";
    }
}
/**
 * Register a comm factory's IPC handlers exactly once. Refuses to shadow an
 * existing method name from a different factory — callers must treat that as a
 * loud, fatal configuration error.
 */
export function registerCommIpcMethods(ipcMethods, factory, deps, options) {
    if (!factory.ipcMethods)
        return;
    const ownerByMethod = options?.commIdByMethod;
    for (const [method, handler] of factory.ipcMethods(deps)) {
        if (ipcMethods.has(method)) {
            const existingCommId = ownerByMethod?.get(method) ?? "unknown";
            throw new DuplicateCommIpcMethodError(method, existingCommId, factory.commId);
        }
        ipcMethods.set(method, handler);
        ownerByMethod?.set(method, factory.commId);
    }
}
//# sourceMappingURL=register-comm-ipc-methods.js.map
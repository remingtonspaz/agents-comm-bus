import type { CommAdapterFactory, CommIpcDeps } from "./comm-factory.js";
import type { IpcMethodHandler } from "./ipc-method.js";

export class DuplicateCommIpcMethodError extends Error {
  constructor(
    public readonly method: string,
    public readonly existingCommId: string,
    public readonly newCommId: string,
  ) {
    super(
      `IPC method "${method}" is already registered for comm "${existingCommId}" ` +
        `(refusing duplicate registration from comm "${newCommId}")`,
    );
    this.name = "DuplicateCommIpcMethodError";
  }
}

/**
 * Register a comm factory's IPC handlers exactly once. Refuses to shadow an
 * existing method name from a different factory — callers must treat that as a
 * loud, fatal configuration error.
 */
export function registerCommIpcMethods(
  ipcMethods: Map<string, IpcMethodHandler>,
  factory: CommAdapterFactory,
  deps: CommIpcDeps,
  options?: { commIdByMethod?: Map<string, string> },
): void {
  if (!factory.ipcMethods) return;
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

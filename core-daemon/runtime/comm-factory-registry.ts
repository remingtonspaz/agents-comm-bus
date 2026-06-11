import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommIpcDeps } from "./comm-factory.js";
import type { IpcMethodHandler } from "./ipc-method.js";
import { registerCommIpcMethods } from "./register-comm-ipc-methods.js";

export interface CommFactoryRegistry {
  readonly factories: CommAdapterFactory[];
  rescanFactoriesForComm(comm: string): Promise<CommAdapterFactory | undefined>;
}

/**
 * Mutable comm-factory set with on-demand additive discovery. Initial factories
 * are registered at construction; `rescanFactoriesForComm` re-runs the loader
 * only when a live session needs a comm whose factory is not yet loaded.
 */
export function createCommFactoryRegistry(input: {
  initial: CommAdapterFactory[];
  loadFactories: () => Promise<CommAdapterFactory[]>;
  ipcMethods: Map<string, IpcMethodHandler>;
  ipcDeps: CommIpcDeps;
}): CommFactoryRegistry {
  const factories: CommAdapterFactory[] = [...input.initial];
  const loadedCommIds = new Set(factories.map((factory) => factory.commId));
  const commIdByMethod = new Map<string, string>();
  let rescanInFlight: Promise<void> | null = null;

  for (const factory of factories) {
    registerCommIpcMethods(input.ipcMethods, factory, input.ipcDeps, { commIdByMethod });
  }

  async function runRescan(): Promise<void> {
    if (rescanInFlight) {
      await rescanInFlight;
      return;
    }
    rescanInFlight = (async () => {
      try {
        const discovered = await input.loadFactories();
        for (const factory of discovered) {
          if (loadedCommIds.has(factory.commId)) continue;
          registerCommIpcMethods(input.ipcMethods, factory, input.ipcDeps, { commIdByMethod });
          factories.push(factory);
          loadedCommIds.add(factory.commId);
        }
      } finally {
        rescanInFlight = null;
      }
    })();
    await rescanInFlight;
  }

  async function rescanFactoriesForComm(comm: string): Promise<CommAdapterFactory | undefined> {
    const existing = factories.find((factory) => factory.commId === comm);
    if (existing) return existing;
    await runRescan();
    return factories.find((factory) => factory.commId === comm);
  }

  return {
    get factories() {
      return factories;
    },
    rescanFactoriesForComm,
  };
}

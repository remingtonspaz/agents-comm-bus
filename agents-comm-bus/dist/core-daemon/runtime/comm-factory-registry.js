import { registerCommIpcMethods } from "./register-comm-ipc-methods.js";
/**
 * Mutable comm-factory set with on-demand additive discovery. Initial factories
 * are registered at construction; `rescanFactoriesForComm` re-runs the loader
 * only when a live session needs a comm whose factory is not yet loaded.
 */
export function createCommFactoryRegistry(input) {
    const factories = [...input.initial];
    const loadedCommIds = new Set(factories.map((factory) => factory.commId));
    const commIdByMethod = new Map();
    let rescanInFlight = null;
    for (const factory of factories) {
        registerCommIpcMethods(input.ipcMethods, factory, input.ipcDeps, { commIdByMethod });
    }
    async function runRescan() {
        if (rescanInFlight) {
            await rescanInFlight;
            return;
        }
        rescanInFlight = (async () => {
            try {
                const discovered = await input.loadFactories();
                for (const factory of discovered) {
                    if (loadedCommIds.has(factory.commId))
                        continue;
                    registerCommIpcMethods(input.ipcMethods, factory, input.ipcDeps, { commIdByMethod });
                    factories.push(factory);
                    loadedCommIds.add(factory.commId);
                }
            }
            finally {
                rescanInFlight = null;
            }
        })();
        await rescanInFlight;
    }
    async function rescanFactoriesForComm(comm) {
        const existing = factories.find((factory) => factory.commId === comm);
        if (existing)
            return existing;
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
//# sourceMappingURL=comm-factory-registry.js.map
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
function defaultOnError({ modulePath, error }) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agents-comm-bus] comm adapter not loaded (${modulePath}): ${message}`);
}
export async function loadCommAdapterFactories(options) {
    const onError = options.onError ?? defaultOnError;
    let entries;
    try {
        entries = await readdir(options.adaptersDir);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const factories = [];
    let resolved = 0;
    for (const entry of entries.sort()) {
        const modulePath = await resolveAdapterModulePath(options.adaptersDir, entry);
        if (!modulePath)
            continue;
        resolved += 1;
        try {
            factories.push(await loadCommAdapterFactory(modulePath));
        }
        catch (error) {
            // Isolate the failure: log it and keep loading the rest.
            onError({ modulePath, error });
        }
    }
    if (resolved > 0 && factories.length === 0) {
        // Every adapter that was present failed. Boot anyway (the agent connection
        // still works), but make the "no comm channels" state unmistakable.
        onError({
            modulePath: options.adaptersDir,
            error: new Error(`no comm adapters loaded: ${resolved} present but all failed — daemon starting with no comm channels`),
        });
    }
    return factories;
}
async function resolveAdapterModulePath(adaptersDir, entry) {
    const entryPath = path.join(adaptersDir, entry);
    if (entry.endsWith(".js"))
        return entryPath;
    try {
        if (!(await stat(entryPath)).isDirectory())
            return null;
    }
    catch {
        return null;
    }
    const factoryPath = path.join(entryPath, "factory.js");
    try {
        if ((await stat(factoryPath)).isFile())
            return factoryPath;
    }
    catch {
        return null;
    }
    return null;
}
async function loadCommAdapterFactory(modulePath) {
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.createCommAdapterFactory !== "function") {
        throw new Error(`comm adapter bundle ${modulePath} must export createCommAdapterFactory()`);
    }
    const factory = mod.createCommAdapterFactory();
    assertCommAdapterFactory(modulePath, factory);
    return factory;
}
function assertCommAdapterFactory(modulePath, value) {
    if (!value || typeof value !== "object") {
        throw new Error(`comm adapter bundle ${modulePath} did not return a factory object`);
    }
    const factory = value;
    if (typeof factory.commId !== "string" || factory.commId.length === 0) {
        throw new Error(`comm adapter bundle ${modulePath} returned a factory without commId`);
    }
    if (typeof factory.resolveCredentials !== "function") {
        throw new Error(`comm adapter bundle ${modulePath} returned a factory without resolveCredentials`);
    }
    if (typeof factory.create !== "function") {
        throw new Error(`comm adapter bundle ${modulePath} returned a factory without create`);
    }
}
//# sourceMappingURL=comm-adapter-loader.js.map
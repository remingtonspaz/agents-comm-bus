import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CommAdapterFactory } from "./comm-factory.js";

export interface CommAdapterLoadFailure {
  /** The adapter module (or, for the all-failed summary, the adapters dir). */
  modulePath: string;
  error: unknown;
}

export interface LoadCommAdapterFactoriesOptions {
  adaptersDir: string;
  /**
   * Called once per adapter that fails to load (import throw, missing
   * `createCommAdapterFactory`, or an invalid factory shape), and once more as a
   * loud summary if adapters were present but none loaded. The loader logs and
   * CONTINUES — one broken/incompatible adapter bundle must never block the
   * daemon from starting with the other comms (and the agent WS connection,
   * which is the daemon's whole job). Defaults to a `console.error` logger.
   */
  onError?: (failure: CommAdapterLoadFailure) => void;
}

function defaultOnError({ modulePath, error }: CommAdapterLoadFailure): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agents-comm-bus] comm adapter not loaded (${modulePath}): ${message}`);
}

export async function loadCommAdapterFactories(
  options: LoadCommAdapterFactoriesOptions,
): Promise<CommAdapterFactory[]> {
  const onError = options.onError ?? defaultOnError;
  let entries: string[];
  try {
    entries = await readdir(options.adaptersDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const factories: CommAdapterFactory[] = [];
  let resolved = 0;
  for (const entry of entries.sort()) {
    const modulePath = await resolveAdapterModulePath(options.adaptersDir, entry);
    if (!modulePath) continue;
    resolved += 1;
    try {
      factories.push(await loadCommAdapterFactory(modulePath));
    } catch (error) {
      // Isolate the failure: log it and keep loading the rest.
      onError({ modulePath, error });
    }
  }

  if (resolved > 0 && factories.length === 0) {
    // Every adapter that was present failed. Boot anyway (the agent connection
    // still works), but make the "no comm channels" state unmistakable.
    onError({
      modulePath: options.adaptersDir,
      error: new Error(
        `no comm adapters loaded: ${resolved} present but all failed — daemon starting with no comm channels`,
      ),
    });
  }

  return factories;
}

async function resolveAdapterModulePath(adaptersDir: string, entry: string): Promise<string | null> {
  const entryPath = path.join(adaptersDir, entry);
  if (entry.endsWith(".js")) return entryPath;
  try {
    if (!(await stat(entryPath)).isDirectory()) return null;
  } catch {
    return null;
  }
  const factoryPath = path.join(entryPath, "factory.js");
  try {
    if ((await stat(factoryPath)).isFile()) return factoryPath;
  } catch {
    return null;
  }
  return null;
}

async function loadCommAdapterFactory(modulePath: string): Promise<CommAdapterFactory> {
  const mod = await import(pathToFileURL(modulePath).href) as {
    createCommAdapterFactory?: unknown;
  };
  if (typeof mod.createCommAdapterFactory !== "function") {
    throw new Error(
      `comm adapter bundle ${modulePath} must export createCommAdapterFactory()`,
    );
  }
  const factory = mod.createCommAdapterFactory();
  assertCommAdapterFactory(modulePath, factory);
  return factory;
}

function assertCommAdapterFactory(modulePath: string, value: unknown): asserts value is CommAdapterFactory {
  if (!value || typeof value !== "object") {
    throw new Error(`comm adapter bundle ${modulePath} did not return a factory object`);
  }
  const factory = value as Partial<CommAdapterFactory>;
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

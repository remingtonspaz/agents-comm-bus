import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CommAdapterFactory } from "./comm-factory.js";

export interface LoadCommAdapterFactoriesOptions {
  adaptersDir: string;
}

export async function loadCommAdapterFactories(
  options: LoadCommAdapterFactoriesOptions,
): Promise<CommAdapterFactory[]> {
  let entries: string[];
  try {
    entries = await readdir(options.adaptersDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const factories: CommAdapterFactory[] = [];
  for (const entry of entries.sort()) {
    const modulePath = await resolveAdapterModulePath(options.adaptersDir, entry);
    if (!modulePath) continue;
    const factory = await loadCommAdapterFactory(modulePath);
    factories.push(factory);
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

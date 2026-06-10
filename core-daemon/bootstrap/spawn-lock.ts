import { constants } from "node:fs";
import { open, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_BOOTSTRAP_TIMEOUT_MS, DEFAULT_SPAWN_LOCK_STALE_GRACE_MS } from "../config.js";

export interface SpawnLock {
  path: string;
  acquired: true;
  token: string;
  release(): Promise<void>;
}

export interface SpawnLockOptions {
  isPidAlive?: (pid: number) => boolean;
  staleTimeoutMs?: number;
  /** Test hook: runs after stale classification, before compare-and-remove. */
  testHookAfterStaleCheck?: () => Promise<void>;
}

export function parseSpawnLockToken(raw: string): { pid?: number; timestamp?: number } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  const parts = trimmed.split(":");
  if (parts.length !== 2) {
    return {};
  }

  const pid = Number(parts[0]);
  const timestamp = Number(parts[1]);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined,
  };
}

export function isTokenContentStale(
  token: string,
  options: Required<Pick<SpawnLockOptions, "isPidAlive" | "staleTimeoutMs">>,
): boolean {
  const { pid, timestamp } = parseSpawnLockToken(token);
  if (pid === undefined || timestamp === undefined) {
    return true;
  }

  if (!options.isPidAlive(pid)) {
    return true;
  }

  return Date.now() - timestamp > options.staleTimeoutMs;
}

export async function isSpawnLockStale(
  lockPath: string,
  options: Required<Pick<SpawnLockOptions, "isPidAlive" | "staleTimeoutMs">>,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return false;
  }

  return isTokenContentStale(raw.trim(), options);
}

export async function removeSpawnLockIfTokenMatches(
  lockPath: string,
  expectedToken: string,
): Promise<boolean> {
  try {
    const current = await readFile(lockPath, "utf8");
    if (current.trim() !== expectedToken) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function removeStaleSpawnLock(
  lockPath: string,
  options: SpawnLockOptions = {},
): Promise<boolean> {
  const resolved = resolveSpawnLockOptions(options);

  let observedRaw: string;
  try {
    observedRaw = await readFile(lockPath, "utf8");
  } catch {
    return false;
  }

  const observedToken = observedRaw.trim();
  if (!isTokenContentStale(observedToken, resolved)) {
    return false;
  }

  if (options.testHookAfterStaleCheck) {
    await options.testHookAfterStaleCheck();
  }

  return removeSpawnLockIfTokenMatches(lockPath, observedToken);
}

export async function tryAcquireSpawnLock(
  lockPath: string,
  options: SpawnLockOptions = {},
): Promise<SpawnLock | undefined> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  const acquired = await createSpawnLock(lockPath);
  if (acquired) {
    return acquired;
  }

  if (!(await removeStaleSpawnLock(lockPath, options))) {
    return undefined;
  }

  return createSpawnLock(lockPath);
}

async function createSpawnLock(lockPath: string): Promise<SpawnLock | undefined> {
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const token = `${process.pid}:${Date.now()}`;
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.close();

    return {
      path: lockPath,
      acquired: true,
      token,
      release: async () => {
        await removeSpawnLockIfTokenMatches(lockPath, token);
      },
    };
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveSpawnLockOptions(options: SpawnLockOptions): Required<Pick<SpawnLockOptions, "isPidAlive" | "staleTimeoutMs">> {
  return {
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    staleTimeoutMs: options.staleTimeoutMs ?? defaultSpawnLockStaleTimeoutMs(),
  };
}

export function defaultSpawnLockStaleTimeoutMs(bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS): number {
  return bootstrapTimeoutMs + DEFAULT_SPAWN_LOCK_STALE_GRACE_MS;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

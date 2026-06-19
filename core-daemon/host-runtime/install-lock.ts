import { constants } from "node:fs";
import { open, readFile, rm, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = { timeoutMs: 5_000, retryMs: 50, staleMs: 30_000 };

export interface InstallLock {
  path: string;
  token: string;
  stoleStale: boolean;
  release: () => Promise<void>;
}

export interface InstallLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function acquireInstallLock(lockPath: string, options: InstallLockOptions = {}): Promise<InstallLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${now()}`;
  const start = now();
  let stoleStale = false;

  for (;;) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.close();
      return {
        path: lockPath,
        token,
        stoleStale,
        release: async () => {
          try {
            const current = await readFile(lockPath, "utf8");
            if (current.trim() === token) {
              await rm(lockPath, { force: true });
            }
          } catch {
            // Best-effort release.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;

      if (await stealIfStale(lockPath, staleMs, now)) {
        stoleStale = true;
        continue;
      }
      if (now() - start >= timeoutMs) {
        throw new Error(`central install lock at ${lockPath} is held; timed out after ${timeoutMs}ms`);
      }
      await sleep(retryMs);
    }
  }
}

async function stealIfStale(lockPath: string, staleMs: number, now: () => number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (now() - info.mtimeMs > staleMs) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    // Disappeared between failed open and stat.
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

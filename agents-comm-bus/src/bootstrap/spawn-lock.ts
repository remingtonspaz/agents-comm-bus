import { constants } from "node:fs";
import { open, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export interface SpawnLock {
  path: string;
  acquired: true;
  release(): Promise<void>;
}

export async function tryAcquireSpawnLock(lockPath: string): Promise<SpawnLock | undefined> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    const token = `${process.pid}:${Date.now()}`;
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.close();

    return {
      path: lockPath,
      acquired: true,
      release: async () => {
        try {
          const current = await readFile(lockPath, "utf8");
          if (current.trim() === token) {
            await rm(lockPath, { force: true });
          }
        } catch {
          // Lock cleanup is best-effort; the next bootstrap can treat it as stale.
        }
      },
    };
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function removeSpawnLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

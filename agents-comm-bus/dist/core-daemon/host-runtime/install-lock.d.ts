import type { FileHandle } from "node:fs/promises";
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
    /** Injectable exclusive-create open (tests); defaults to node fs/promises open. */
    open?: (lockPath: string, flags: number) => Promise<FileHandle>;
    /** Injectable platform gate (tests); defaults to process.platform. */
    platform?: NodeJS.Platform;
}
export declare function acquireInstallLock(lockPath: string, options?: InstallLockOptions): Promise<InstallLock>;
//# sourceMappingURL=install-lock.d.ts.map
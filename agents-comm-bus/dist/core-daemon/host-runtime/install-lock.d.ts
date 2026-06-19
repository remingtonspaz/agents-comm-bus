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
export declare function acquireInstallLock(lockPath: string, options?: InstallLockOptions): Promise<InstallLock>;
//# sourceMappingURL=install-lock.d.ts.map
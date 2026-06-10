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
export declare function parseSpawnLockToken(raw: string): {
    pid?: number;
    timestamp?: number;
};
export declare function isTokenContentStale(token: string, options: Required<Pick<SpawnLockOptions, "isPidAlive" | "staleTimeoutMs">>): boolean;
export declare function isSpawnLockStale(lockPath: string, options: Required<Pick<SpawnLockOptions, "isPidAlive" | "staleTimeoutMs">>): Promise<boolean>;
export declare function removeSpawnLockIfTokenMatches(lockPath: string, expectedToken: string): Promise<boolean>;
export declare function removeStaleSpawnLock(lockPath: string, options?: SpawnLockOptions): Promise<boolean>;
export declare function tryAcquireSpawnLock(lockPath: string, options?: SpawnLockOptions): Promise<SpawnLock | undefined>;
export declare function defaultSpawnLockStaleTimeoutMs(bootstrapTimeoutMs?: number): number;
//# sourceMappingURL=spawn-lock.d.ts.map
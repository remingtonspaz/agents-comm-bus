export interface SpawnLock {
    path: string;
    acquired: true;
    release(): Promise<void>;
}
export declare function tryAcquireSpawnLock(lockPath: string): Promise<SpawnLock | undefined>;
export declare function removeSpawnLock(lockPath: string): Promise<void>;
//# sourceMappingURL=spawn-lock.d.ts.map
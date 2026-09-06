export interface DiscoveryGuardSelf {
    pid: number;
    startedAt: number | null;
}
export interface DiscoveryGuardToken {
    pid: number;
    startedAt: number | null;
    at: number;
    nonce: string;
}
export interface WithDiscoveryGuardOptions {
    maxWaitMs?: number;
    isPidAlive?: (pid: number) => boolean;
    /** Injectable clock for tests (defaults to Date.now). */
    now?: () => number;
    /** Test hook: invoked immediately before publishing the guard token via link. */
    beforeGuardLink?: () => Promise<void>;
    /** Test hook: invoked after a dead guard is verified and before reclaim-lock acquisition. */
    beforeReclaim?: () => Promise<void>;
    /** Test hook: invoked after validating a dead reclaim token and before reclaim2 acquisition. */
    beforeReclaim2?: () => Promise<void>;
    /** Test hook: invoked after the reclaim lock is held and before quarantining the main guard. */
    beforeQuarantine?: () => Promise<void>;
}
export type WithDiscoveryGuardResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: "guard_contended";
};
export declare function discoveryGuardFile(discoveryRoot: string): string;
export declare function discoveryReclaimLockFile(discoveryRoot: string): string;
export declare function discoveryReclaim2LockFile(discoveryRoot: string): string;
export declare function resetDiscoveryGuardTestState(): void;
export declare function parseDiscoveryGuardToken(raw: string): DiscoveryGuardToken | undefined;
export declare function guardTokensEqual(a: DiscoveryGuardToken, b: DiscoveryGuardToken): boolean;
export declare function withDiscoveryGuard<T>(discoveryRoot: string, self: DiscoveryGuardSelf, fn: () => Promise<T>, options?: WithDiscoveryGuardOptions): Promise<WithDiscoveryGuardResult<T>>;
/** Test helper: read the current guard token raw bytes, if any. */
export declare function readDiscoveryGuardRaw(discoveryRoot: string): Promise<string | null>;
/** Test helper: read the current reclaim lock raw bytes, if any. */
export declare function readDiscoveryReclaimRaw(discoveryRoot: string): Promise<string | null>;
/** Test helper: read the current reclaim2 lock raw bytes, if any. */
export declare function readDiscoveryReclaim2Raw(discoveryRoot: string): Promise<string | null>;
/** Test helper: whether a guard file exists with empty content. */
export declare function isDiscoveryGuardEmpty(discoveryRoot: string): Promise<boolean>;
//# sourceMappingURL=discovery-guard.d.ts.map
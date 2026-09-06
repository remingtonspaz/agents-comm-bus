import type { DaemonHello } from "../ipc/protocol.js";
export interface DiscoveryClaim {
    pid: number;
    port: number;
    stateRoot: string;
    startedAt: number | null;
    protocolVersion: string;
}
export type ClaimDiscoveryResult = {
    ok: true;
    claim: DiscoveryClaim;
} | {
    ok: false;
    reason: "incumbent";
    winner: DiscoveryClaim;
} | {
    ok: false;
    reason: "incumbent_busy";
    incumbent: DiscoveryClaim;
};
export declare class DiscoveryClaimLostError extends Error {
    readonly winner: DiscoveryClaim;
    constructor(winner: DiscoveryClaim);
}
export type DiscoverySpawnLock = {
    release(): Promise<void>;
};
export interface ClaimDiscoveryInput {
    stateRoot: string;
    discoveryRoot?: string;
    pid?: number;
    port: number;
    startedAt?: number | null;
    protocolVersion?: string;
    isPidAlive?: (pid: number) => boolean;
    probeDaemon?: (port: number) => Promise<DaemonHello>;
    /** When set, stale/foreign replacement audits are written here. */
    auditStateRoot?: string;
    acquireLock?: (lockPath: string) => Promise<DiscoverySpawnLock | undefined>;
    /** Invoked immediately before an exclusive owner.json create attempt. */
    beforeCreate?: () => Promise<void>;
}
export interface WriteDaemonDiscoveryFilesInput {
    stateRoot?: string;
    discoveryRoot?: string;
    pid?: number;
    port: number;
    startedAt?: number | null;
    isPidAlive?: (pid: number) => boolean;
    probeDaemon?: (port: number) => Promise<DaemonHello>;
}
export declare function discoveryOwnerFile(discoveryRoot: string): string;
export declare function readDiscoveryClaim(discoveryRoot: string): Promise<DiscoveryClaim | undefined>;
export declare function parseDiscoveryClaim(raw: string): DiscoveryClaim | undefined;
export declare function discoveryClaimIdentityMatches(claim: DiscoveryClaim, selfPid: number, selfStartedAt: number | null): boolean;
export declare function claimDiscovery(input: ClaimDiscoveryInput): Promise<ClaimDiscoveryResult>;
export declare function writeDaemonDiscoveryFiles(input: WriteDaemonDiscoveryFilesInput): Promise<void>;
//# sourceMappingURL=discovery-claim.d.ts.map
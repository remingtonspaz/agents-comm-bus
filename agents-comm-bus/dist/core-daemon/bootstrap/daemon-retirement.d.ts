import type { AuditStore } from "agents-comm-bus-core";
export declare const IDLE_NO_OWNED_RESOURCES_REASON = "idle_no_owned_resources";
export interface DiscoveryOwnershipInput {
    selfPid: number;
    selfPort: number;
    onDiskPid: number | null | undefined;
    onDiskPort: number | null | undefined;
}
/**
 * AGE-36: discovery files may be removed only when BOTH on-disk pid and port
 * still match this daemon. A successor/main daemon's discovery must never be
 * deleted by a retiring stray.
 */
export declare function discoveryFilesMatchSelf(input: DiscoveryOwnershipInput): boolean;
export interface RemoveDiscoveryFilesInput {
    stateRoot?: string;
    discoveryRoot?: string;
    selfPid: number;
    selfPort: number;
    readPidFile?: (pidFile: string) => Promise<number | null>;
    readPortFile?: (portFile: string) => Promise<number | null>;
}
export declare function removeDiscoveryFilesIfOwned(input: RemoveDiscoveryFilesInput): Promise<boolean>;
export interface DaemonRetirementOptions {
    reason: string;
    selfPid?: number;
    port: number;
    stateRoot?: string;
    discoveryRoot?: string;
    audit?: AuditStore;
    log?: (message: string) => void;
    stopTimers?: () => void;
    stopBus?: () => Promise<void>;
    closeIpc?: () => Promise<void>;
    closeStorage?: () => Promise<void>;
    removeDiscoveryFiles?: (input: RemoveDiscoveryFilesInput) => Promise<boolean>;
    exitProcess?: (code: number) => void;
}
export declare function resetDaemonRetirementGuardForTests(): void;
/**
 * Idempotent daemon self-retirement path shared by AGE-36 idle reaper and AGE-12
 * pid watchdog supersede handling.
 */
export declare function retireDaemon(options: DaemonRetirementOptions): Promise<boolean>;
//# sourceMappingURL=daemon-retirement.d.ts.map
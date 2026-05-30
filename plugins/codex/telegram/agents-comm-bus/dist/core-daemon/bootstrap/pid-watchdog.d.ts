import type { AuditStore } from "agents-comm-bus-core";
import { writeDaemonDiscoveryFiles } from "./ensure-daemon.js";
export type DaemonPidWatchdogResult = {
    status: "current";
    selfPid: number;
} | {
    status: "superseded";
    selfPid: number;
    ownerPid: number;
} | {
    status: "reclaimed";
    selfPid: number;
    reason: "missing" | "dead_owner";
    ownerPid?: number;
} | {
    status: "stayed_alive";
    selfPid: number;
    reason: "invalid_pid" | "read_error" | "liveness_error" | "reclaim_error";
    ownerPid?: number;
    error?: string;
};
export type PidFileRead = {
    status: "pid";
    pid: number;
} | {
    status: "missing";
} | {
    status: "invalid";
    raw: string;
} | {
    status: "error";
    error: unknown;
};
export interface DaemonPidWatchdogCheckOptions {
    stateRoot?: string;
    pidFile: string;
    port: number;
    selfPid?: number;
    readPidFile?: (pidFile: string) => Promise<PidFileRead>;
    isPidAlive?: (pid: number) => boolean;
    writeDiscoveryFiles?: typeof writeDaemonDiscoveryFiles;
}
export interface DaemonPidWatchdogTickOptions extends DaemonPidWatchdogCheckOptions {
    audit?: AuditStore;
    stopDaemon?: () => Promise<void> | void;
    exitProcess?: (code: number) => void;
}
export interface StartDaemonPidWatchdogOptions extends DaemonPidWatchdogTickOptions {
    intervalMs?: number;
    initialDelayMs?: number;
}
export interface DaemonPidWatchdogHandle {
    stop(): void;
}
export declare function startDaemonPidWatchdog(options: StartDaemonPidWatchdogOptions): DaemonPidWatchdogHandle;
export declare function runDaemonPidWatchdogTick(options: DaemonPidWatchdogTickOptions): Promise<DaemonPidWatchdogResult>;
export declare function checkDaemonPidOwnership(options: DaemonPidWatchdogCheckOptions): Promise<DaemonPidWatchdogResult>;
//# sourceMappingURL=pid-watchdog.d.ts.map
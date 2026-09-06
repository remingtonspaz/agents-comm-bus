import { type AgentsCommBusDiscoveryPaths, type AgentsCommBusPaths, type DiscoveryPathOptions } from "../paths.js";
import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";
import { writeDaemonDiscoveryFiles, type WriteDaemonDiscoveryFilesInput } from "./discovery-claim.js";
export { writeDaemonDiscoveryFiles, type WriteDaemonDiscoveryFilesInput };
export interface EnsureDaemonOptions extends DiscoveryPathOptions {
    env?: NodeJS.ProcessEnv;
    clientVersion?: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
    timeoutMs?: number;
    retryMs?: number;
    probeDaemon?: (port: number) => Promise<DaemonHello>;
    spawnDaemon?: (paths: AgentsCommBusPaths, discoveryPaths: AgentsCommBusDiscoveryPaths) => Promise<void> | void;
    terminateDaemon?: (pid: number) => Promise<void> | void;
    isPidAlive?: (pid: number) => boolean;
    log?: (message: string) => void;
}
export interface EnsureDaemonResult {
    port: number;
    hello: DaemonHello;
    spawned: boolean;
}
export declare function ensureDaemon(options?: EnsureDaemonOptions): Promise<EnsureDaemonResult>;
export declare function daemonStderrLogPath(stateRoot: string): string;
/** Spawn stdio for a detached daemon child: stdout+stderr share an append log fd. */
export declare function daemonSpawnStdio(stateRoot: string): ["ignore", number, number];
export declare function cleanupStalePidAndPort(input: {
    stateRoot: string;
    discoveryRoot: string;
    pidFile: string;
    portFile: string;
    isPidAlive: (pid: number) => boolean;
}): Promise<void>;
//# sourceMappingURL=ensure-daemon.d.ts.map
import { type AgentsCommBusDiscoveryPaths, type AgentsCommBusPaths, type DiscoveryPathOptions } from "../paths.js";
import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";
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
export declare function writeDaemonDiscoveryFiles(input: {
    stateRoot?: string;
    discoveryRoot?: string;
    pid?: number;
    port: number;
    probeDaemon?: (port: number) => Promise<DaemonHello>;
}): Promise<void>;
//# sourceMappingURL=ensure-daemon.d.ts.map
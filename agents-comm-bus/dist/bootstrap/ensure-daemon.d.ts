import { resolveStatePaths, type StatePathOptions } from "../paths.js";
import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";
export interface EnsureDaemonOptions extends StatePathOptions {
    clientVersion?: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
    timeoutMs?: number;
    retryMs?: number;
    probeDaemon?: (port: number) => Promise<DaemonHello>;
    spawnDaemon?: (paths: ReturnType<typeof resolveStatePaths>) => Promise<void> | void;
    isPidAlive?: (pid: number) => boolean;
}
export interface EnsureDaemonResult {
    port: number;
    hello: DaemonHello;
    spawned: boolean;
}
export declare function ensureDaemon(options?: EnsureDaemonOptions): Promise<EnsureDaemonResult>;
export declare function writeDaemonDiscoveryFiles(input: {
    stateRoot?: string;
    pid?: number;
    port: number;
    probeDaemon?: (port: number) => Promise<DaemonHello>;
}): Promise<void>;
//# sourceMappingURL=ensure-daemon.d.ts.map
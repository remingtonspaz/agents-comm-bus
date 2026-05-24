import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";
export interface ProbeDaemonOptions {
    port: number;
    clientVersion?: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
    timeoutMs?: number;
}
export declare function probeDaemon(options: ProbeDaemonOptions): Promise<DaemonHello>;
//# sourceMappingURL=handshake.d.ts.map
import { type WebSocket } from "ws";
import { type DaemonHello, type DiagnosticMetadata, type IpcRequest } from "./protocol.js";
export interface IpcServerOptions {
    host?: string;
    port?: number;
    protocolVersion?: string;
    daemonVersion?: string;
    metadata?: DiagnosticMetadata;
    onRequest?: (request: IpcRequest, socket: WebSocket) => Promise<unknown>;
}
export interface RunningIpcServer {
    port: number;
    host: string;
    url: string;
    hello: DaemonHello;
    /** AGE-36: live WebSocket clients (handshaking + established). */
    getLiveConnectionCount(): number;
    close(): Promise<void>;
}
export declare function startIpcServer(options?: IpcServerOptions): Promise<RunningIpcServer>;
//# sourceMappingURL=server.d.ts.map
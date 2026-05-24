import WebSocket from "ws";
import { type DaemonHello, type DiagnosticMetadata } from "./protocol.js";
export interface IpcClientOptions {
    host?: string;
    port: number;
    protocolVersion?: string;
    clientVersion: string;
    metadata?: DiagnosticMetadata;
    timeoutMs?: number;
}
export interface IpcClientConnection {
    socket: WebSocket;
    hello: DaemonHello;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    close(): void;
}
export declare function connectIpc(options: IpcClientOptions): Promise<IpcClientConnection>;
//# sourceMappingURL=client.d.ts.map
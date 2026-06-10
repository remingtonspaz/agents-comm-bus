import WebSocket from "ws";
import { type DaemonHello, type DiagnosticMetadata } from "./protocol.js";
/**
 * Conservative default for in-flight IPC requests.
 * Keep above CodexBridge's blocking permission-query poll cap (~9m); Claude
 * permission opens return immediately and resolve later through wake typing.
 */
export declare const DEFAULT_IPC_REQUEST_TIMEOUT_MS: number;
export declare class IpcRequestTimeoutError extends Error {
    readonly requestId: string;
    readonly method: string;
    readonly timeoutMs: number;
    constructor(requestId: string, method: string, timeoutMs: number);
}
export interface IpcClientOptions {
    host?: string;
    port: number;
    protocolVersion?: string;
    clientVersion: string;
    metadata?: DiagnosticMetadata;
    /** Connect + handshake timeout. Default 1s. */
    timeoutMs?: number;
    /** Per-request timeout after handshake. Default {@link DEFAULT_IPC_REQUEST_TIMEOUT_MS}. */
    requestTimeoutMs?: number;
}
export interface IpcClientConnection {
    socket: WebSocket;
    hello: DaemonHello;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    close(): void;
}
export declare function connectIpc(options: IpcClientOptions): Promise<IpcClientConnection>;
//# sourceMappingURL=client.d.ts.map
import { DAEMON_NAME } from "../config.js";
export declare const IPC_MESSAGE_TYPES: {
    readonly clientHello: "client.hello";
    readonly daemonHello: "daemon.hello";
    readonly daemonError: "daemon.error";
    readonly request: "request";
    readonly response: "response";
};
export type IpcMessageType = (typeof IPC_MESSAGE_TYPES)[keyof typeof IPC_MESSAGE_TYPES];
export interface DiagnosticMetadata {
    pluginInstanceId?: string;
    shimName?: string;
    agent?: string;
    project?: string;
    pid?: number;
    cwd?: string;
    [key: string]: unknown;
}
export interface ClientHello {
    type: typeof IPC_MESSAGE_TYPES.clientHello;
    protocolVersion: string;
    clientVersion: string;
    metadata: DiagnosticMetadata;
}
export interface DaemonHello {
    type: typeof IPC_MESSAGE_TYPES.daemonHello;
    protocolVersion: string;
    daemonVersion: string;
    daemonName: typeof DAEMON_NAME;
    metadata: DiagnosticMetadata;
}
export interface DaemonError {
    type: typeof IPC_MESSAGE_TYPES.daemonError;
    code: "protocol_version_mismatch" | "bad_handshake";
    message: string;
    protocolVersion: string;
    daemonVersion: string;
    metadata: DiagnosticMetadata;
}
export interface IpcRequest {
    type: typeof IPC_MESSAGE_TYPES.request;
    id: string;
    method: string;
    params?: unknown;
}
export interface IpcResponse {
    type: typeof IPC_MESSAGE_TYPES.response;
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}
/** Runtime summary returned by the intrinsic `daemon_status` IPC method (AGE-57). */
export interface DaemonStatusResponse {
    daemon_version: string;
    live_adapters: readonly string[];
    pending_inbound_depth: number;
    active_scope_count: number;
}
export type HandshakeMessage = ClientHello | DaemonHello | DaemonError;
export type IpcMessage = HandshakeMessage | IpcRequest | IpcResponse;
export declare function createClientHello(input: {
    clientVersion: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
}): ClientHello;
export declare function createDaemonHello(input?: {
    daemonVersion?: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
}): DaemonHello;
export declare function createProtocolMismatchError(input: {
    clientProtocolVersion: string;
    daemonVersion?: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
}): DaemonError;
export declare function parseIpcMessage(data: unknown): IpcMessage;
export declare function parseHandshakeMessage(data: unknown): HandshakeMessage;
export declare function validateClientHello(message: HandshakeMessage): ClientHello;
export declare function isClientCompatible(clientHello: ClientHello, daemonProtocolVersion?: string): boolean;
export declare function createRequest(method: string, params?: unknown): IpcRequest;
//# sourceMappingURL=protocol.d.ts.map
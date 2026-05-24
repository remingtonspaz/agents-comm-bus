import { DAEMON_NAME, DAEMON_VERSION, IPC_PROTOCOL_VERSION, isProtocolCompatible, } from "../config.js";
export const IPC_MESSAGE_TYPES = {
    clientHello: "client.hello",
    daemonHello: "daemon.hello",
    daemonError: "daemon.error",
    request: "request",
    response: "response",
};
export function createClientHello(input) {
    return {
        type: IPC_MESSAGE_TYPES.clientHello,
        protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
        clientVersion: input.clientVersion,
        metadata: {
            pid: process.pid,
            cwd: process.cwd(),
            ...input.metadata,
        },
    };
}
export function createDaemonHello(input = {}) {
    return {
        type: IPC_MESSAGE_TYPES.daemonHello,
        protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
        daemonVersion: input.daemonVersion ?? DAEMON_VERSION,
        daemonName: DAEMON_NAME,
        metadata: {
            pid: process.pid,
            cwd: process.cwd(),
            ...input.metadata,
        },
    };
}
export function createProtocolMismatchError(input) {
    const protocolVersion = input.protocolVersion ?? IPC_PROTOCOL_VERSION;
    return {
        type: IPC_MESSAGE_TYPES.daemonError,
        code: "protocol_version_mismatch",
        message: `agents-comm-bus IPC protocol mismatch: daemon supports ${protocolVersion}, client requested ${input.clientProtocolVersion}. Upgrade the older daemon or plugin shim so their major protocol versions match.`,
        protocolVersion,
        daemonVersion: input.daemonVersion ?? DAEMON_VERSION,
        metadata: input.metadata ?? {},
    };
}
export function parseIpcMessage(data) {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const parsed = JSON.parse(text);
    if (parsed.type !== IPC_MESSAGE_TYPES.clientHello &&
        parsed.type !== IPC_MESSAGE_TYPES.daemonHello &&
        parsed.type !== IPC_MESSAGE_TYPES.daemonError &&
        parsed.type !== IPC_MESSAGE_TYPES.request &&
        parsed.type !== IPC_MESSAGE_TYPES.response) {
        throw new Error("Invalid agents-comm-bus IPC message type.");
    }
    return parsed;
}
export function parseHandshakeMessage(data) {
    const message = parseIpcMessage(data);
    if (message.type !== IPC_MESSAGE_TYPES.clientHello &&
        message.type !== IPC_MESSAGE_TYPES.daemonHello &&
        message.type !== IPC_MESSAGE_TYPES.daemonError) {
        throw new Error("Invalid agents-comm-bus IPC handshake message type.");
    }
    return message;
}
export function validateClientHello(message) {
    if (message.type !== IPC_MESSAGE_TYPES.clientHello ||
        typeof message.protocolVersion !== "string" ||
        typeof message.clientVersion !== "string") {
        throw new Error("Expected agents-comm-bus client hello handshake.");
    }
    return message;
}
export function isClientCompatible(clientHello, daemonProtocolVersion = IPC_PROTOCOL_VERSION) {
    return isProtocolCompatible(daemonProtocolVersion, clientHello.protocolVersion);
}
export function createRequest(method, params) {
    return {
        type: IPC_MESSAGE_TYPES.request,
        id: cryptoRandomId(),
        method,
        params,
    };
}
function cryptoRandomId() {
    return `ipc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
//# sourceMappingURL=protocol.js.map
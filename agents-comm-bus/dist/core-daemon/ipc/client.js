import WebSocket from "ws";
import { IPC_HOST, IPC_PROTOCOL_VERSION } from "../config.js";
import { IPC_MESSAGE_TYPES, createRequest, createClientHello, parseIpcMessage, parseHandshakeMessage, } from "./protocol.js";
/** Conservative default for in-flight IPC requests (Codex permission hooks may wait up to ~9m). */
export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
export class IpcRequestTimeoutError extends Error {
    requestId;
    method;
    timeoutMs;
    constructor(requestId, method, timeoutMs) {
        super(`agents-comm-bus IPC request timed out after ${timeoutMs}ms ` +
            `(method=${method}, id=${requestId}). ` +
            "The daemon may be hung; restart it (kill the PID in ~/.agents-comm-bus/daemon.pid, " +
            "remove port + daemon.pid) and retry.");
        this.name = "IpcRequestTimeoutError";
        this.requestId = requestId;
        this.method = method;
        this.timeoutMs = timeoutMs;
    }
}
export async function connectIpc(options) {
    const host = options.host ?? IPC_HOST;
    const timeoutMs = options.timeoutMs ?? 1_000;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_IPC_REQUEST_TIMEOUT_MS;
    const socket = new WebSocket(`ws://${host}:${options.port}`);
    const hello = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`Timed out waiting for agents-comm-bus IPC handshake on ${host}:${options.port}.`));
        }, timeoutMs);
        socket.once("open", () => {
            socket.send(JSON.stringify(createClientHello({
                clientVersion: options.clientVersion,
                protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION,
                metadata: options.metadata,
            })));
        });
        socket.once("message", (data) => {
            try {
                const message = parseHandshakeMessage(data);
                if (message.type === IPC_MESSAGE_TYPES.daemonError) {
                    throw new Error(message.message);
                }
                if (message.type !== IPC_MESSAGE_TYPES.daemonHello) {
                    throw new Error("Expected agents-comm-bus daemon hello handshake.");
                }
                clearTimeout(timeout);
                resolve(message);
            }
            catch (error) {
                clearTimeout(timeout);
                socket.close();
                reject(error);
            }
        });
        socket.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
    return {
        socket,
        hello,
        request: (method, params) => sendRequest(socket, createRequest(method, params), requestTimeoutMs),
        close: () => socket.close(),
    };
}
async function sendRequest(socket, request, requestTimeoutMs) {
    socket.send(JSON.stringify(request));
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("message", onMessage);
        };
        const settle = (fn) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            fn();
        };
        const timeout = setTimeout(() => {
            settle(() => {
                reject(new IpcRequestTimeoutError(request.id, request.method, requestTimeoutMs));
            });
        }, requestTimeoutMs);
        timeout.unref?.();
        const onMessage = (data) => {
            try {
                const message = parseIpcMessage(data);
                if (message.type !== IPC_MESSAGE_TYPES.response || message.id !== request.id) {
                    return;
                }
                const response = message;
                if (!response.ok) {
                    settle(() => {
                        reject(new Error(response.error ?? "agents-comm-bus request failed"));
                    });
                    return;
                }
                settle(() => {
                    resolve(response.result);
                });
            }
            catch (error) {
                settle(() => {
                    reject(error);
                });
            }
        };
        const onError = (error) => {
            settle(() => {
                reject(error);
            });
        };
        const onClose = () => {
            settle(() => {
                reject(new Error("agents-comm-bus IPC socket closed before the request completed."));
            });
        };
        socket.on("message", onMessage);
        socket.once("error", onError);
        socket.once("close", onClose);
    });
}
//# sourceMappingURL=client.js.map
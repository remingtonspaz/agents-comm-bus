import WebSocket from "ws";
import { IPC_HOST, IPC_PROTOCOL_VERSION } from "../config.js";
import { IPC_MESSAGE_TYPES, createRequest, createClientHello, parseIpcMessage, parseHandshakeMessage, } from "./protocol.js";
export async function connectIpc(options) {
    const host = options.host ?? IPC_HOST;
    const timeoutMs = options.timeoutMs ?? 1_000;
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
        request: (method, params) => sendRequest(socket, createRequest(method, params)),
        close: () => socket.close(),
    };
}
async function sendRequest(socket, request) {
    socket.send(JSON.stringify(request));
    return new Promise((resolve, reject) => {
        const onMessage = (data) => {
            try {
                const message = parseIpcMessage(data);
                if (message.type !== IPC_MESSAGE_TYPES.response || message.id !== request.id) {
                    return;
                }
                socket.off("message", onMessage);
                const response = message;
                if (!response.ok) {
                    reject(new Error(response.error ?? "agents-comm-bus request failed"));
                    return;
                }
                resolve(response.result);
            }
            catch (error) {
                socket.off("message", onMessage);
                reject(error);
            }
        };
        socket.on("message", onMessage);
    });
}
//# sourceMappingURL=client.js.map
import WebSocket, { type RawData } from "ws";

import { IPC_HOST, IPC_PROTOCOL_VERSION } from "../config.js";
import {
  IPC_MESSAGE_TYPES,
  createRequest,
  createClientHello,
  parseIpcMessage,
  parseHandshakeMessage,
  type DaemonHello,
  type DiagnosticMetadata,
  type IpcRequest,
  type IpcResponse,
} from "./protocol.js";

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

export async function connectIpc(options: IpcClientOptions): Promise<IpcClientConnection> {
  const host = options.host ?? IPC_HOST;
  const timeoutMs = options.timeoutMs ?? 1_000;
  const socket = new WebSocket(`ws://${host}:${options.port}`);

  const hello = await new Promise<DaemonHello>((resolve, reject) => {
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
      } catch (error) {
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

async function sendRequest<T>(socket: WebSocket, request: IpcRequest): Promise<T> {
  socket.send(JSON.stringify(request));
  return new Promise<T>((resolve, reject) => {
    const onMessage = (data: RawData) => {
      try {
        const message = parseIpcMessage(data);
        if (message.type !== IPC_MESSAGE_TYPES.response || message.id !== request.id) {
          return;
        }
        socket.off("message", onMessage);
        const response = message as IpcResponse;
        if (!response.ok) {
          reject(new Error(response.error ?? "agents-comm-bus request failed"));
          return;
        }
        resolve(response.result as T);
      } catch (error) {
        socket.off("message", onMessage);
        reject(error);
      }
    };
    socket.on("message", onMessage);
  });
}

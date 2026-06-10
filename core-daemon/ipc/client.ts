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

/** Conservative default for in-flight IPC requests (Codex permission hooks may wait up to ~9m). */
export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;

export class IpcRequestTimeoutError extends Error {
  readonly requestId: string;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(requestId: string, method: string, timeoutMs: number) {
    super(
      `agents-comm-bus IPC request timed out after ${timeoutMs}ms ` +
        `(method=${method}, id=${requestId}). ` +
        "The daemon may be hung; restart it (kill the PID in ~/.agents-comm-bus/daemon.pid, " +
        "remove port + daemon.pid) and retry.",
    );
    this.name = "IpcRequestTimeoutError";
    this.requestId = requestId;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
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

export async function connectIpc(options: IpcClientOptions): Promise<IpcClientConnection> {
  const host = options.host ?? IPC_HOST;
  const timeoutMs = options.timeoutMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_IPC_REQUEST_TIMEOUT_MS;
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
    request: (method, params) =>
      sendRequest(socket, createRequest(method, params), requestTimeoutMs),
    close: () => socket.close(),
  };
}

async function sendRequest<T>(
  socket: WebSocket,
  request: IpcRequest,
  requestTimeoutMs: number,
): Promise<T> {
  socket.send(JSON.stringify(request));
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onMessage = (data: RawData) => {
      try {
        const message = parseIpcMessage(data);
        if (message.type !== IPC_MESSAGE_TYPES.response || message.id !== request.id) {
          return;
        }
        const response = message as IpcResponse;
        if (!response.ok) {
          settle(() => {
            reject(new Error(response.error ?? "agents-comm-bus request failed"));
          });
          return;
        }
        settle(() => {
          resolve(response.result as T);
        });
      } catch (error) {
        settle(() => {
          reject(error);
        });
      }
    };

    const onError = (error: Error) => {
      settle(() => {
        reject(error);
      });
    };

    const onClose = () => {
      settle(() => {
        reject(new Error("agents-comm-bus IPC socket closed before the request completed."));
      });
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
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

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

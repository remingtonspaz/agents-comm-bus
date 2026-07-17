import { WebSocketServer, type WebSocket, type RawData } from "ws";

import { DAEMON_VERSION, IPC_HOST, IPC_PROTOCOL_VERSION } from "../config.js";
import {
  IPC_MESSAGE_TYPES,
  createDaemonHello,
  createProtocolMismatchError,
  isClientCompatible,
  parseHandshakeMessage,
  parseIpcMessage,
  validateClientHello,
  type DaemonHello,
  type DiagnosticMetadata,
  type IpcRequest,
} from "./protocol.js";

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

export async function startIpcServer(options: IpcServerOptions = {}): Promise<RunningIpcServer> {
  const host = options.host ?? IPC_HOST;
  const port = options.port ?? 0;
  const protocolVersion = options.protocolVersion ?? IPC_PROTOCOL_VERSION;
  const daemonVersion = options.daemonVersion ?? DAEMON_VERSION;
  const metadata = options.metadata ?? {};
  const server = new WebSocketServer({ host, port });
  let liveConnectionCount = 0;

  server.on("connection", (socket) => {
    liveConnectionCount += 1;
    socket.once("close", () => {
      liveConnectionCount -= 1;
    });
    handleHandshake(socket, { protocolVersion, daemonVersion, metadata, onRequest: options.onRequest });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("agents-comm-bus IPC server did not bind to a TCP port.");
  }

  const boundPort = address.port;
  const hello = createDaemonHello({ daemonVersion, protocolVersion, metadata });

  return {
    port: boundPort,
    host,
    url: `ws://${host}:${boundPort}`,
    hello,
    getLiveConnectionCount: () => liveConnectionCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function handleHandshake(
  socket: WebSocket,
  daemon: {
    protocolVersion: string;
    daemonVersion: string;
    metadata: DiagnosticMetadata;
    onRequest?: (request: IpcRequest, socket: WebSocket) => Promise<unknown>;
  },
): void {
  socket.once("message", (data: RawData) => {
    try {
      const clientHello = validateClientHello(parseHandshakeMessage(data));

      if (!isClientCompatible(clientHello, daemon.protocolVersion)) {
        socket.send(JSON.stringify(createProtocolMismatchError({
          clientProtocolVersion: clientHello.protocolVersion,
          daemonVersion: daemon.daemonVersion,
          protocolVersion: daemon.protocolVersion,
          metadata: daemon.metadata,
        })));
        socket.close(4002, "IPC protocol mismatch");
        return;
      }

      socket.send(JSON.stringify(createDaemonHello({
        daemonVersion: daemon.daemonVersion,
        protocolVersion: daemon.protocolVersion,
        metadata: daemon.metadata,
      })));
      socket.on("message", (requestData: RawData) => {
        void handleRequest(socket, requestData, daemon.onRequest);
      });
    } catch (error) {
      socket.send(JSON.stringify({
        type: IPC_MESSAGE_TYPES.daemonError,
        code: "bad_handshake",
        message: error instanceof Error ? error.message : "Invalid agents-comm-bus IPC handshake.",
        protocolVersion: daemon.protocolVersion,
        daemonVersion: daemon.daemonVersion,
        metadata: daemon.metadata,
      }));
      socket.close(4003, "Bad IPC handshake");
    }
  });
}

async function handleRequest(
  socket: WebSocket,
  data: RawData,
  onRequest: IpcServerOptions["onRequest"],
): Promise<void> {
  let request: IpcRequest;
  try {
    const message = parseIpcMessage(data);
    if (message.type !== IPC_MESSAGE_TYPES.request) return;
    request = message;
  } catch {
    return;
  }

  try {
    if (!onRequest) throw new Error("daemon has no IPC request handler");
    const result = await onRequest(request, socket);
    socket.send(JSON.stringify({
      type: IPC_MESSAGE_TYPES.response,
      id: request.id,
      ok: true,
      result,
    }));
  } catch (error) {
    socket.send(JSON.stringify({
      type: IPC_MESSAGE_TYPES.response,
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

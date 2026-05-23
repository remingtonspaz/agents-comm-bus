import {
  DAEMON_NAME,
  DAEMON_VERSION,
  IPC_PROTOCOL_VERSION,
  isProtocolCompatible,
} from "../config.js";

export const IPC_MESSAGE_TYPES = {
  clientHello: "client.hello",
  daemonHello: "daemon.hello",
  daemonError: "daemon.error",
  request: "request",
  response: "response",
} as const;

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

export type HandshakeMessage = ClientHello | DaemonHello | DaemonError;
export type IpcMessage = HandshakeMessage | IpcRequest | IpcResponse;

export function createClientHello(input: {
  clientVersion: string;
  protocolVersion?: string;
  metadata?: DiagnosticMetadata;
}): ClientHello {
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

export function createDaemonHello(input: {
  daemonVersion?: string;
  protocolVersion?: string;
  metadata?: DiagnosticMetadata;
} = {}): DaemonHello {
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

export function createProtocolMismatchError(input: {
  clientProtocolVersion: string;
  daemonVersion?: string;
  protocolVersion?: string;
  metadata?: DiagnosticMetadata;
}): DaemonError {
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

export function parseIpcMessage(data: unknown): IpcMessage {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const parsed = JSON.parse(text) as Partial<IpcMessage>;

  if (
    parsed.type !== IPC_MESSAGE_TYPES.clientHello &&
    parsed.type !== IPC_MESSAGE_TYPES.daemonHello &&
    parsed.type !== IPC_MESSAGE_TYPES.daemonError &&
    parsed.type !== IPC_MESSAGE_TYPES.request &&
    parsed.type !== IPC_MESSAGE_TYPES.response
  ) {
    throw new Error("Invalid agents-comm-bus IPC message type.");
  }

  return parsed as IpcMessage;
}

export function parseHandshakeMessage(data: unknown): HandshakeMessage {
  const message = parseIpcMessage(data);
  if (
    message.type !== IPC_MESSAGE_TYPES.clientHello &&
    message.type !== IPC_MESSAGE_TYPES.daemonHello &&
    message.type !== IPC_MESSAGE_TYPES.daemonError
  ) {
    throw new Error("Invalid agents-comm-bus IPC handshake message type.");
  }
  return message;
}

export function validateClientHello(message: HandshakeMessage): ClientHello {
  if (
    message.type !== IPC_MESSAGE_TYPES.clientHello ||
    typeof message.protocolVersion !== "string" ||
    typeof message.clientVersion !== "string"
  ) {
    throw new Error("Expected agents-comm-bus client hello handshake.");
  }

  return message;
}

export function isClientCompatible(clientHello: ClientHello, daemonProtocolVersion = IPC_PROTOCOL_VERSION): boolean {
  return isProtocolCompatible(daemonProtocolVersion, clientHello.protocolVersion);
}

export function createRequest(method: string, params?: unknown): IpcRequest {
  return {
    type: IPC_MESSAGE_TYPES.request,
    id: cryptoRandomId(),
    method,
    params,
  };
}

function cryptoRandomId(): string {
  return `ipc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

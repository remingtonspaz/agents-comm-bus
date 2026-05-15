import { DAEMON_VERSION, IPC_PROTOCOL_VERSION } from "../config.js";
import { connectIpc } from "../ipc/client.js";
import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";

export interface ProbeDaemonOptions {
  port: number;
  clientVersion?: string;
  protocolVersion?: string;
  metadata?: DiagnosticMetadata;
  timeoutMs?: number;
}

export async function probeDaemon(options: ProbeDaemonOptions): Promise<DaemonHello> {
  const connection = await connectIpc({
    port: options.port,
    clientVersion: options.clientVersion ?? DAEMON_VERSION,
    protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION,
    metadata: options.metadata,
    timeoutMs: options.timeoutMs,
  });

  connection.close();
  return connection.hello;
}

export const DAEMON_NAME = "agents-comm-bus";
export const DAEMON_VERSION = "0.2.5";
export const IPC_PROTOCOL_VERSION = "1.0.0";
export const IPC_HOST = "127.0.0.1";

export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const DEFAULT_BOOTSTRAP_RETRY_MS = 50;

export function protocolMajor(version: string): string {
  return version.split(".", 1)[0] ?? version;
}

export function isProtocolCompatible(
  daemonProtocolVersion: string,
  clientProtocolVersion: string,
): boolean {
  return protocolMajor(daemonProtocolVersion) === protocolMajor(clientProtocolVersion);
}

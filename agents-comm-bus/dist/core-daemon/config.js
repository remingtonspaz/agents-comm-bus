export const DAEMON_NAME = "agents-comm-bus";
export const DAEMON_VERSION = "0.2.9";
export const IPC_PROTOCOL_VERSION = "1.0.0";
export const IPC_HOST = "127.0.0.1";
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const DEFAULT_BOOTSTRAP_RETRY_MS = 50;
export function protocolMajor(version) {
    return version.split(".", 1)[0] ?? version;
}
export function isProtocolCompatible(daemonProtocolVersion, clientProtocolVersion) {
    return protocolMajor(daemonProtocolVersion) === protocolMajor(clientProtocolVersion);
}
//# sourceMappingURL=config.js.map
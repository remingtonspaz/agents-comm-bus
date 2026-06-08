export declare const DAEMON_NAME = "agents-comm-bus";
export declare const DAEMON_VERSION = "0.2.15";
export declare const IPC_PROTOCOL_VERSION = "1.0.0";
export declare const IPC_HOST = "127.0.0.1";
export declare const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5000;
export declare const DEFAULT_BOOTSTRAP_RETRY_MS = 50;
export declare function protocolMajor(version: string): string;
export declare function isProtocolCompatible(daemonProtocolVersion: string, clientProtocolVersion: string): boolean;
//# sourceMappingURL=config.d.ts.map
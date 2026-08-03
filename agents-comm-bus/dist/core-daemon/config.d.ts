export declare const DAEMON_NAME = "agents-comm-bus";
export declare const DAEMON_VERSION = "0.2.45";
export declare const IPC_PROTOCOL_VERSION = "1.2.0";
export declare const IPC_HOST = "127.0.0.1";
export declare const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 20000;
export declare const DEFAULT_BOOTSTRAP_RETRY_MS = 50;
/** Grace beyond a caller bootstrap timeout before a spawn lock is treated as stale. */
export declare const DEFAULT_SPAWN_LOCK_STALE_GRACE_MS = 2000;
export declare function protocolMajor(version: string): string;
export declare function isProtocolCompatible(daemonProtocolVersion: string, clientProtocolVersion: string): boolean;
//# sourceMappingURL=config.d.ts.map
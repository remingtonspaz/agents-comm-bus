import { type EnsureDaemonOptions } from "../bootstrap/ensure-daemon.js";
import { type DaemonHello, type DiagnosticMetadata } from "./protocol.js";
export interface PersistentIpcClientOptions {
    clientVersion: string;
    protocolVersion?: string;
    metadata?: DiagnosticMetadata;
    host?: string;
    /** Forwarded to `ensureDaemon`; respawns the daemon if it died. */
    spawnDaemon?: EnsureDaemonOptions["spawnDaemon"];
    /** Per-attempt connect+handshake timeout. Default 5s. */
    connectTimeoutMs?: number;
    /** Minimum reconnect backoff. Default 250ms. */
    minBackoffMs?: number;
    /** Maximum reconnect backoff. Default 30s. */
    maxBackoffMs?: number;
    /** Called on first successful connect. */
    onConnected?: (hello: DaemonHello) => void | Promise<void>;
    /** Called on each subsequent successful connect (i.e. reconnects). */
    onReconnected?: (hello: DaemonHello) => void | Promise<void>;
    /** Called when the socket drops (intentional close or otherwise). */
    onDisconnected?: (reason: string) => void;
    /** Diagnostic callback for non-fatal errors (parse errors, send failures). */
    onError?: (error: Error) => void;
    /** Sink for diagnostic log lines. */
    log?: (message: string) => void;
}
export declare class DisconnectedError extends Error {
    readonly retryable = true;
    constructor(message?: string);
}
export declare class PersistentIpcClient {
    private readonly options;
    private socket;
    private hello;
    private readonly replayRequests;
    private readonly inFlight;
    private reconnectTimer;
    private reconnectAttempt;
    private closed;
    private connecting;
    constructor(options: PersistentIpcClientOptions);
    /** Connect for the first time and resolve once handshake completes. */
    start(): Promise<DaemonHello>;
    /**
     * Issue `method` now AND queue it for replay on every future reconnect.
     * Returns the result of the first call. Replay failures on reconnect are
     * surfaced via `onError` only — they do not throw to the original caller.
     *
     * Use for `*_register_session` and similar resume-the-session calls.
     */
    registerReplay(method: string, params: unknown): Promise<unknown>;
    /**
     * Fire-and-await on the current connection. Throws `DisconnectedError`
     * if there is no live socket; the caller decides whether to wait for
     * reconnect or surface the failure.
     */
    request(method: string, params?: unknown): Promise<unknown>;
    /** Intentional shutdown. Cancels reconnect and rejects in-flight requests. */
    close(): void;
    private ensureConnected;
    private connectOnce;
    private replayRegistrations;
    private handleClose;
    private scheduleReconnect;
    private requestOnCurrentConnection;
    private handleMessage;
    private log;
}
//# sourceMappingURL=persistent-client.d.ts.map
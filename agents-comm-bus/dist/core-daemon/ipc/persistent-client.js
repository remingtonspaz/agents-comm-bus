/**
 * Long-lived IPC client that survives daemon respawns.
 *
 * The plain `connectIpc` in `client.ts` is intentionally single-shot — fine
 * for one-off hook calls, but the MCP shim holds a connection for the
 * lifetime of an agent session and was forced to die whenever the daemon
 * was restarted (which then required restarting the agent process to get
 * the MCP tools back).
 *
 * `PersistentIpcClient` adds:
 *   - A reconnect state machine with exponential backoff + jitter.
 *   - `registerReplay(method, params)` — requests that are re-issued on
 *     every reconnect (typically `*_register_session`). The daemon's
 *     registration handlers are idempotent enough for this to work as the
 *     resume mechanism for stateful sessions; combined with
 *     `replace_existing_lease: true`, the post-restart lease columns are
 *     wiped and re-acquired transparently.
 *   - `request(method, params)` — one-off request on the current
 *     connection. Rejects with `DisconnectedError` if there is no live
 *     socket; callers can choose to retry or surface the failure.
 *   - Each reconnect attempt routes through `ensureDaemon`, so a daemon
 *     that exited (rather than just dropping the socket) gets respawned
 *     during the reconnect dance — no separate "ensure" call from the
 *     caller is needed.
 */
import WebSocket from "ws";
import { IPC_HOST, IPC_PROTOCOL_VERSION } from "../config.js";
import { ensureDaemon, } from "../bootstrap/ensure-daemon.js";
import { IPC_MESSAGE_TYPES, createClientHello, createRequest, parseHandshakeMessage, parseIpcMessage, } from "./protocol.js";
export class DisconnectedError extends Error {
    retryable = true;
    constructor(message = "agents-comm-bus IPC connection unavailable") {
        super(message);
        this.name = "DisconnectedError";
    }
}
export class PersistentIpcClient {
    options;
    socket = null;
    hello = null;
    replayRequests = [];
    inFlight = new Map();
    reconnectTimer = null;
    reconnectAttempt = 0;
    closed = false;
    connecting = null;
    constructor(options) {
        this.options = options;
    }
    /** Connect for the first time and resolve once handshake completes. */
    async start() {
        await this.ensureConnected();
        if (!this.hello) {
            throw new Error("agents-comm-bus IPC handshake did not deliver a daemon hello");
        }
        return this.hello;
    }
    /**
     * Issue `method` now AND queue it for replay on every future reconnect.
     * Returns the result of the first call. Replay failures on reconnect are
     * surfaced via `onError` only — they do not throw to the original caller.
     *
     * Use for `*_register_session` and similar resume-the-session calls.
     */
    async registerReplay(method, params) {
        this.replayRequests.push({ method, params });
        return this.requestOnCurrentConnection(method, params);
    }
    /**
     * Fire-and-await on the current connection. Throws `DisconnectedError`
     * if there is no live socket; the caller decides whether to wait for
     * reconnect or surface the failure.
     */
    async request(method, params) {
        return this.requestOnCurrentConnection(method, params);
    }
    /** Intentional shutdown. Cancels reconnect and rejects in-flight requests. */
    close() {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.close();
            }
            catch {
                // best-effort
            }
            this.socket = null;
        }
        for (const pending of this.inFlight.values()) {
            pending.reject(new DisconnectedError("PersistentIpcClient closed"));
        }
        this.inFlight.clear();
    }
    async ensureConnected() {
        if (this.closed) {
            throw new DisconnectedError("PersistentIpcClient is closed");
        }
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return;
        }
        if (this.connecting) {
            return this.connecting;
        }
        this.connecting = this.connectOnce().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }
    async connectOnce() {
        const ensured = await ensureDaemon({
            clientVersion: this.options.clientVersion,
            protocolVersion: this.options.protocolVersion,
            metadata: this.options.metadata,
            spawnDaemon: this.options.spawnDaemon,
        });
        const host = this.options.host ?? IPC_HOST;
        const socket = new WebSocket(`ws://${host}:${ensured.port}`);
        const timeoutMs = this.options.connectTimeoutMs ?? 5_000;
        const hello = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                try {
                    socket.close();
                }
                catch { }
                reject(new Error(`agents-comm-bus IPC handshake timeout on ${host}:${ensured.port}`));
            }, timeoutMs);
            socket.once("open", () => {
                try {
                    socket.send(JSON.stringify(createClientHello({
                        clientVersion: this.options.clientVersion,
                        protocolVersion: this.options.protocolVersion ?? IPC_PROTOCOL_VERSION,
                        metadata: this.options.metadata,
                    })));
                }
                catch (err) {
                    clearTimeout(timer);
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
            socket.once("message", (data) => {
                try {
                    const message = parseHandshakeMessage(data);
                    if (message.type === IPC_MESSAGE_TYPES.daemonError) {
                        throw new Error(message.message);
                    }
                    if (message.type !== IPC_MESSAGE_TYPES.daemonHello) {
                        throw new Error("Expected agents-comm-bus daemon hello handshake");
                    }
                    clearTimeout(timer);
                    resolve(message);
                }
                catch (err) {
                    clearTimeout(timer);
                    try {
                        socket.close();
                    }
                    catch { }
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
            socket.once("error", (err) => {
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
        const wasReconnect = this.reconnectAttempt > 0;
        this.socket = socket;
        this.hello = hello;
        this.reconnectAttempt = 0;
        socket.on("message", (data) => this.handleMessage(data));
        socket.on("close", () => this.handleClose("socket closed"));
        socket.on("error", (err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.options.onError?.(error);
        });
        if (wasReconnect) {
            this.log(`reconnected on port ${ensured.port}`);
            await this.options.onReconnected?.(hello);
        }
        else {
            this.log(`connected on port ${ensured.port}`);
            await this.options.onConnected?.(hello);
        }
        if (this.replayRequests.length > 0) {
            await this.replayRegistrations();
        }
    }
    async replayRegistrations() {
        for (const replay of this.replayRequests) {
            try {
                await this.requestOnCurrentConnection(replay.method, replay.params);
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                this.log(`replay registration failed for ${replay.method}: ${error.message}`);
                this.options.onError?.(error);
            }
        }
    }
    handleClose(reason) {
        if (this.socket)
            this.socket = null;
        for (const pending of this.inFlight.values()) {
            pending.reject(new DisconnectedError(reason));
        }
        this.inFlight.clear();
        this.options.onDisconnected?.(reason);
        if (this.closed)
            return;
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer)
            return;
        const minMs = this.options.minBackoffMs ?? 250;
        const maxMs = this.options.maxBackoffMs ?? 30_000;
        const exp = Math.min(maxMs, minMs * 2 ** this.reconnectAttempt);
        const jitter = Math.random() * 0.3 * exp;
        const delay = Math.floor(exp + jitter);
        this.reconnectAttempt += 1;
        this.log(`scheduling reconnect attempt ${this.reconnectAttempt} in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureConnected().catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.log(`reconnect attempt ${this.reconnectAttempt} failed: ${message}`);
                if (!this.closed)
                    this.scheduleReconnect();
            });
        }, delay);
        this.reconnectTimer.unref?.();
    }
    async requestOnCurrentConnection(method, params) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new DisconnectedError(`agents-comm-bus IPC not connected (request ${method})`);
        }
        const request = createRequest(method, params);
        return new Promise((resolve, reject) => {
            this.inFlight.set(request.id, { resolve, reject });
            try {
                this.socket.send(JSON.stringify(request));
            }
            catch (err) {
                this.inFlight.delete(request.id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    handleMessage(data) {
        let message;
        try {
            message = parseIpcMessage(data);
        }
        catch (err) {
            this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
            return;
        }
        if (message.type !== IPC_MESSAGE_TYPES.response)
            return;
        const response = message;
        const pending = this.inFlight.get(response.id);
        if (!pending)
            return;
        this.inFlight.delete(response.id);
        if (!response.ok) {
            pending.reject(new Error(response.error ?? "agents-comm-bus request failed"));
        }
        else {
            pending.resolve(response.result);
        }
    }
    log(message) {
        this.options.log?.(message);
    }
}
//# sourceMappingURL=persistent-client.js.map
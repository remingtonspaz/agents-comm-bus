import WebSocket from "ws";
export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";
const CLIENT_INFO = {
    name: "agents-comm-bus-codex-bridge",
    version: "0.1.0",
};
export class WebSocketCodexAppServerClient {
    url;
    constructor(url = DEFAULT_CODEX_APP_SERVER_URL) {
        this.url = url;
    }
    call(method, params, options = {}) {
        return callOnce(this.url, method, params, options);
    }
    listLoadedThreads() {
        return this.call("thread/loaded/list", {});
    }
    listThreadTurns(threadId) {
        return this.call("thread/turns/list", { threadId });
    }
    startTurn(threadId, text) {
        return this.call("turn/start", {
            threadId,
            input: [{ type: "text", text }],
        });
    }
    steerTurn(threadId, text, expectedTurnId) {
        return this.call("turn/steer", {
            threadId,
            expectedTurnId,
            input: [{ type: "text", text }],
        });
    }
    async wakeMostRecentThread(text = ".") {
        const thread = await this.mostRecentThread();
        if (!thread.ok)
            return thread;
        try {
            await this.startTurn(thread.threadId, text);
            return { ok: true, threadId: thread.threadId, method: "turn/start" };
        }
        catch (error) {
            return {
                ok: false,
                reason: "startTurn-failed",
                error: error instanceof Error ? error.message : String(error),
                threadId: thread.threadId,
            };
        }
    }
    async steerMostRecentThread(text) {
        const thread = await this.mostRecentThread();
        if (!thread.ok)
            return thread;
        const turn = await this.activeTurn(thread.threadId);
        if (!turn.ok)
            return turn;
        try {
            await this.steerTurn(thread.threadId, text, turn.turnId);
            return { ok: true, threadId: thread.threadId, method: "turn/steer" };
        }
        catch (error) {
            return {
                ok: false,
                reason: "steerTurn-failed",
                error: error instanceof Error ? error.message : String(error),
                threadId: thread.threadId,
            };
        }
    }
    async mostRecentThread() {
        let result;
        try {
            result = await this.listLoadedThreads();
        }
        catch (error) {
            return {
                ok: false,
                reason: "listLoadedThreads-failed",
                error: error instanceof Error ? error.message : String(error),
                url: this.url,
            };
        }
        const threads = loadedThreads(result);
        if (threads.length === 0) {
            return {
                ok: false,
                reason: "no-threads-loaded",
                raw: stringifyShort(result),
            };
        }
        const target = [...threads].sort(compareThreadRecency)[0];
        const threadId = threadIdFrom(target);
        if (!threadId) {
            return {
                ok: false,
                reason: "no-thread-id-in-response",
                raw: stringifyShort(target),
            };
        }
        return { ok: true, threadId };
    }
    async activeTurn(threadId) {
        let result;
        try {
            result = await this.listThreadTurns(threadId);
        }
        catch (error) {
            return {
                ok: false,
                reason: "listThreadTurns-failed",
                error: error instanceof Error ? error.message : String(error),
                threadId,
                url: this.url,
            };
        }
        const turns = listedTurns(result);
        if (turns.length === 0) {
            return {
                ok: false,
                reason: "no-turns-loaded",
                raw: stringifyShort(result),
                threadId,
            };
        }
        const active = turns.find((turn) => turnStatus(turn) === "inProgress") ?? turns[0];
        const turnId = turnIdFrom(active);
        if (!turnId) {
            return {
                ok: false,
                reason: "no-turn-id-in-response",
                raw: stringifyShort(active),
                threadId,
            };
        }
        return { ok: true, turnId };
    }
}
function callOnce(url, method, params, { timeoutMs = 5_000 } = {}) {
    return new Promise((resolve, reject) => {
        let ws;
        try {
            ws = new WebSocket(url);
        }
        catch (error) {
            reject(error);
            return;
        }
        const initId = 1;
        const callId = 2;
        let settled = false;
        let initialized = false;
        const timer = setTimeout(() => {
            finish(new Error(`app-server JSON-RPC timeout after ${timeoutMs}ms (method=${method}, url=${url})`));
        }, timeoutMs);
        function finish(error, value) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                ws.close();
            }
            catch {
                // Ignore close failures on a failing one-shot call.
            }
            if (error)
                reject(error);
            else
                resolve(value);
        }
        ws.on("open", () => {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: initId,
                method: "initialize",
                params: { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } },
            }));
        });
        ws.on("message", (data) => {
            const message = parseJsonMessage(data);
            if (!message)
                return;
            if (message.id === initId) {
                if (message.error) {
                    finish(new Error(`app-server initialize failed: ${message.error.code} ${message.error.message ?? ""}`));
                    return;
                }
                initialized = true;
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }));
                return;
            }
            if (message.id === callId) {
                if (message.error) {
                    finish(new Error(`app-server JSON-RPC error ${message.error.code}: ${message.error.message ?? ""}`));
                }
                else {
                    finish(null, message.result);
                }
            }
        });
        ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
        ws.on("close", () => {
            if (!settled) {
                finish(new Error(initialized
                    ? "app-server connection closed after initialize but before reply"
                    : "app-server connection closed before initialize completed"));
            }
        });
    });
}
function loadedThreads(result) {
    if (Array.isArray(result))
        return result;
    if (!result || typeof result !== "object")
        return [];
    const record = result;
    const candidate = record.data ?? record.threads ?? record.items ?? record.loaded;
    return Array.isArray(candidate) ? candidate : [];
}
function listedTurns(result) {
    if (Array.isArray(result))
        return result;
    if (!result || typeof result !== "object")
        return [];
    const record = result;
    const candidate = record.data ?? record.turns ?? record.items;
    return Array.isArray(candidate) ? candidate : [];
}
function compareThreadRecency(a, b) {
    if (typeof a === "string" || typeof b === "string")
        return 0;
    const left = Date.parse(String(a?.lastActiveAt
        ?? a?.updatedAt
        ?? a?.startedAt
        ?? 0)) || 0;
    const right = Date.parse(String(b?.lastActiveAt
        ?? b?.updatedAt
        ?? b?.startedAt
        ?? 0)) || 0;
    return right - left;
}
function threadIdFrom(value) {
    if (typeof value === "string" && value.length > 0)
        return value;
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const id = record.threadId ?? record.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}
function turnIdFrom(value) {
    if (typeof value === "string" && value.length > 0)
        return value;
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const id = record.turnId ?? record.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}
function turnStatus(value) {
    if (!value || typeof value !== "object")
        return null;
    const status = value.status;
    return typeof status === "string" ? status : null;
}
function parseJsonMessage(data) {
    try {
        const value = JSON.parse(data.toString());
        return value && typeof value === "object" ? value : null;
    }
    catch {
        return null;
    }
}
function stringifyShort(value) {
    try {
        return JSON.stringify(value).slice(0, 500);
    }
    catch {
        return String(value).slice(0, 500);
    }
}
//# sourceMappingURL=app-server.js.map
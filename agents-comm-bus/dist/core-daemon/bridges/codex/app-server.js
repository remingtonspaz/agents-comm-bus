import WebSocket from "ws";
import { normalizeProjectPath } from "../../project-path.js";
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
    listThreads() {
        return this.call("thread/list", {});
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
    async validateRecordedTarget(target) {
        if (!target.threadId || !target.expectedProject) {
            return { ok: false, reason: "missing-recorded-target", threadId: target.threadId };
        }
        let result;
        try {
            result = await this.listThreads();
        }
        catch (error) {
            return {
                ok: false,
                reason: "listThreads-failed",
                error: error instanceof Error ? error.message : String(error),
                threadId: target.threadId,
                url: this.url,
            };
        }
        const threads = listedThreads(result);
        const match = threads.find((entry) => threadIdFrom(entry) === target.threadId);
        if (!match) {
            return {
                ok: false,
                reason: "recorded-thread-absent",
                threadId: target.threadId,
                raw: stringifyShort(result),
            };
        }
        const statusType = threadStatusType(match);
        if (!isLiveThreadStatus(statusType)) {
            return {
                ok: false,
                reason: "recorded-thread-not-live",
                threadId: target.threadId,
                raw: stringifyShort(match),
            };
        }
        const cwd = threadCwd(match);
        if (!cwd) {
            return {
                ok: false,
                reason: "recorded-thread-missing-cwd",
                threadId: target.threadId,
                raw: stringifyShort(match),
            };
        }
        if (normalizeProjectPath(cwd) !== normalizeProjectPath(target.expectedProject)) {
            return {
                ok: false,
                reason: "recorded-thread-wrong-project",
                threadId: target.threadId,
                raw: stringifyShort(match),
            };
        }
        return { ok: true, threadId: target.threadId, cwd };
    }
    async wakeRecordedTarget(target, text = ".") {
        const validated = await this.validateRecordedTarget(target);
        if (!validated.ok)
            return validated;
        try {
            await this.startTurn(validated.threadId, text);
            return { ok: true, threadId: validated.threadId, method: "turn/start" };
        }
        catch (error) {
            return {
                ok: false,
                reason: "startTurn-failed",
                error: error instanceof Error ? error.message : String(error),
                threadId: validated.threadId,
            };
        }
    }
    async steerRecordedTarget(target, text) {
        const validated = await this.validateRecordedTarget(target);
        if (!validated.ok)
            return validated;
        const turn = await this.activeTurn(validated.threadId);
        if (!turn.ok)
            return turn;
        try {
            await this.steerTurn(validated.threadId, text, turn.turnId);
            return { ok: true, threadId: validated.threadId, method: "turn/steer" };
        }
        catch (error) {
            return {
                ok: false,
                reason: "steerTurn-failed",
                error: error instanceof Error ? error.message : String(error),
                threadId: validated.threadId,
            };
        }
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
function listedThreads(result) {
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
function threadIdFrom(value) {
    if (typeof value === "string" && value.length > 0)
        return value;
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const id = record.threadId ?? record.id;
    return typeof id === "string" && id.length > 0 ? id : null;
}
function threadCwd(value) {
    if (!value || typeof value !== "object")
        return null;
    const cwd = value.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}
function threadStatusType(value) {
    if (!value || typeof value !== "object")
        return null;
    const status = value.status;
    if (!status || typeof status !== "object")
        return null;
    const type = status.type;
    return typeof type === "string" ? type : null;
}
export function isLiveThreadStatus(statusType) {
    return statusType === "active" || statusType === "idle";
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
import crypto from "node:crypto";
import { SCHEMA_VERSION_SESSION, } from "../../../../../agents-comm-bus-core/dist/index.js";
import { CodexAgentAdapter, codexDecisionFromResolution, codexHookDecision, } from "./adapter.js";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_QUERY_POLL_TIMEOUT_MS = 9 * 60 * 1000;
const CODEX_IPC_METHODS = new Set([
    "codex_register_session",
    "codex_drain_inbound",
    "codex_open_query",
    "codex_turn_control",
]);
export class CodexBridge {
    options;
    agentId = "codex";
    ipcMethods = CODEX_IPC_METHODS;
    adapter;
    waiters = new Map();
    sessionsByProject = new Map();
    constructor(options) {
        this.options = options;
        this.adapter = new CodexAgentAdapter({
            defaultAppServerUrl: options.defaultAppServerUrl ?? process.env.CODEX_APP_SERVER_URL,
        });
    }
    attach(comms) {
        this.options.bus.setResolveSink({
            onResolved: async (query, decision) => {
                if (query.agent !== this.agentId)
                    return;
                this.waiters.get(query.query_id)?.(decision);
            },
        });
        for (const comm of comms) {
            if (typeof comm.onCallback === "function") {
                comm.onCallback(async (event) => {
                    await this.handleCommCallback(comm, event);
                });
            }
        }
    }
    async onInboundConversation(conversation) {
        if (conversation.agent !== this.agentId)
            return;
        const sessions = this.sessionsByProject.get(conversation.project);
        const session = sessions?.values().next().value;
        if (!session) {
            return;
        }
        try {
            await this.adapter.wake(session);
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async handleIpcMethod(method, params, ctx) {
        switch (method) {
            case "codex_register_session":
                return this.registerSession(params, ctx.socket);
            case "codex_drain_inbound":
                return this.drainInbound(params);
            case "codex_open_query":
                return this.openQuery(params);
            case "codex_turn_control":
                return this.turnControl(params);
            default:
                throw new Error(`CodexBridge does not handle IPC method: ${method}`);
        }
    }
    async registerSession(params, socket) {
        const session = requiredString(params.session, "session");
        const project = requiredString(params.project, "project");
        const connectionId = typeof params.connection_id === "string"
            ? params.connection_id
            : `codex:${session}:${crypto.randomUUID()}`;
        const now = Date.now();
        await this.options.storage.upsertSession({
            schema_version: SCHEMA_VERSION_SESSION,
            session_id: session,
            agent: this.agentId,
            project,
            created_at: now,
            lease_holder_connection_id: null,
            lease_acquired_at: null,
            lease_released_at: null,
            most_recent_inbound_conversation_id: null,
            status: "active",
        });
        const acquired = await this.options.storage.acquireSessionLease(session, connectionId, now);
        if (!acquired) {
            return { ok: false, reason: "same-project codex session lease already held" };
        }
        const control = new BridgeControlChannel();
        await this.adapter.connect(session, control);
        if (typeof params.app_server_url === "string") {
            this.adapter.setAppServerUrl(session, params.app_server_url);
        }
        this.trackSession(project, session);
        const release = () => {
            this.untrackSession(project, session);
            void this.adapter.disconnect(session);
            void this.options.storage.releaseSessionLease(session, connectionId, Date.now());
            control.close();
        };
        socket?.once("close", release);
        return { ok: true, capabilities: this.adapter.capabilities };
    }
    async drainInbound(params) {
        const session = typeof params.session === "string" ? params.session : undefined;
        const drained = this.options.pendingInbound.splice(0);
        if (session && drained.length > 0) {
            await this.options.storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id);
        }
        return drained;
    }
    async openQuery(params) {
        const session = requiredString(params.session, "session");
        const queryInput = recordOrEmpty(params.query);
        const promptText = requiredString(params.prompt_text ?? queryInput.prompt_text, "prompt_text");
        const queryId = `q_${crypto.randomUUID()}`;
        const sessionRecord = await this.options.storage.getSession(session);
        const conversation = sessionRecord?.most_recent_inbound_conversation_id
            ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
            : null;
        const originChat = conversation
            ? {
                comm: conversation.comm,
                account: conversation.account_label,
                chat_native_id: conversation.chat_native_id,
                thread_native_id: conversation.thread_native_id ?? undefined,
            }
            : undefined;
        if (!originChat) {
            const hookResponse = codexHookDecision("deny", `No recent inbound Telegram conversation is associated with Codex session ${session}.`);
            return {
                query_id: queryId,
                hook_response: hookResponse,
                hookJson: hookResponse,
                nativeHookJson: hookResponse,
            };
        }
        const query = {
            schema_version: 1,
            query_id: queryId,
            agent: this.agentId,
            session,
            kind: "approval",
            prompt_text: promptText,
            origin_chat: originChat,
            created_at: Date.now(),
            ttl_seconds: typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS,
        };
        await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
        const resolutionPromise = this.waitForResolution(queryId, query.ttl_seconds);
        await this.options.bus.openQuery(query);
        const promptFormat = params.prompt_format ?? queryInput.prompt_format;
        await this.options.bus.send({
            session,
            comm: originChat.comm,
            target: originChat,
            payload: {
                text: promptText,
                format: promptFormat === "html" ? "html" : "plain",
                inline_keyboard: inlineKeyboardForQuery(queryId),
            },
            idempotencyKey: `query:${queryId}`,
        });
        const decision = await resolutionPromise;
        const hookResponse = codexDecisionFromResolution(decision);
        return {
            query_id: queryId,
            hook_response: hookResponse,
            hookJson: hookResponse,
            nativeHookJson: hookResponse,
        };
    }
    async turnControl(params) {
        const session = requiredString(params.session, "session");
        const kind = params.kind === "steer" ? "steer" : params.kind === "interrupt" ? "interrupt" : "start";
        if (typeof params.app_server_url === "string") {
            this.adapter.setAppServerUrl(session, params.app_server_url);
        }
        if (kind === "start") {
            await this.adapter.wake(session);
            return { ok: true, method: "turn/start" };
        }
        if (kind === "steer") {
            await this.adapter.steer(session, params.payload ?? params.text ?? "");
            return { ok: true, method: "turn/steer" };
        }
        await this.adapter.interrupt(session);
        return { ok: true, method: "turn/interrupt" };
    }
    async handleCommCallback(comm, event) {
        const parsed = parseCallbackData(event.data);
        if (!parsed)
            return;
        const openQuery = await this.options.storage.getOpenQueryById(parsed.queryId);
        if (!openQuery || openQuery.agent !== this.agentId) {
            return;
        }
        const chat = {
            comm: comm.id,
            account: "",
            chat_native_id: event.chat_native_id,
        };
        const outcome = await this.options.bus.resolveQueryFromCallback({
            queryId: parsed.queryId,
            value: parsed.value,
            fromId: event.from_id,
            chat,
        });
        if (!comm.answerCallback)
            return;
        if (outcome.kind === "resolved") {
            await comm.answerCallback(event.callback_id, { text: ackTextFor(outcome.decision) });
            if (comm.editMessage) {
                try {
                    await comm.editMessage(event.chat_native_id, event.message_native_id, `Resolved via Telegram (${ackTextFor(outcome.decision)}).`);
                }
                catch {
                    // Best-effort UI update only.
                }
            }
            return;
        }
        if (outcome.kind === "already_resolved") {
            await comm.answerCallback(event.callback_id, { text: "Already resolved." });
            return;
        }
        if (outcome.kind === "invalid_value") {
            await comm.answerCallback(event.callback_id, { text: `Unrecognized value: ${outcome.value}` });
            return;
        }
        await comm.answerCallback(event.callback_id, { text: outcome.kind });
    }
    waitForResolution(queryId, ttlSeconds) {
        const timeoutMs = Math.min(this.options.queryPollTimeoutMs ?? DEFAULT_QUERY_POLL_TIMEOUT_MS, Math.max(1, ttlSeconds) * 1000);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.waiters.delete(queryId);
                resolve(null);
            }, timeoutMs);
            this.waiters.set(queryId, (decision) => {
                clearTimeout(timer);
                this.waiters.delete(queryId);
                resolve(decision);
            });
        });
    }
    trackSession(project, session) {
        const sessions = this.sessionsByProject.get(project) ?? new Set();
        sessions.add(session);
        this.sessionsByProject.set(project, sessions);
    }
    untrackSession(project, session) {
        const sessions = this.sessionsByProject.get(project);
        if (!sessions)
            return;
        sessions.delete(session);
        if (sessions.size === 0)
            this.sessionsByProject.delete(project);
    }
}
function inlineKeyboardForQuery(queryId) {
    return [
        [
            { text: "Allow", callback_data: `q:${queryId}:y` },
            { text: "Deny", callback_data: `q:${queryId}:n` },
        ],
        [{ text: "Always", callback_data: `q:${queryId}:a` }],
    ];
}
function parseCallbackData(data) {
    if (!data.startsWith("q:"))
        return null;
    const rest = data.slice(2);
    const sep = rest.lastIndexOf(":");
    if (sep <= 0)
        return null;
    const queryId = rest.slice(0, sep);
    const value = rest.slice(sep + 1);
    if (!queryId || !value)
        return null;
    return { queryId, value };
}
function ackTextFor(decision) {
    switch (decision.decision) {
        case "allow":
            return "Allowed";
        case "always_allow":
            return "Allowed";
        case "deny":
            return "Denied";
        default:
            return "Recorded";
    }
}
function requiredString(paramsValue, name) {
    if (typeof paramsValue !== "string" || paramsValue.length === 0) {
        throw new Error(`${name} is required`);
    }
    return paramsValue;
}
function recordOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
class BridgeControlChannel {
    closeHandler = null;
    onClose(handler) {
        this.closeHandler = handler;
    }
    async send(_envelope) {
        // Bridge-local adapter control frames are diagnostic only for now.
    }
    close() {
        this.closeHandler?.();
    }
}
export class CodexBridgeFactory {
    agentId = "codex";
    create(context) {
        return new CodexBridge({
            storage: context.storage,
            bus: context.bus,
            pendingInbound: context.pendingInbound,
        });
    }
}
//# sourceMappingURL=bridge.js.map
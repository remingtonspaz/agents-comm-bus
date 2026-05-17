/**
 * ClaudeBridge — Claude-side of the agents-comm-bus daemon.
 *
 * Hosts the `claude_*` IPC methods, the inline-keyboard label choices
 * specific to Claude's permission / question UX, the wake-on-resolve write
 * path (`permission-response.json` + `trigger-enter`), and the per-comm
 * callback handler. The daemon constructs one ClaudeBridge and asks it to
 * `attach` to the bus + the running comm adapters; everything Claude-specific
 * stays inside this module.
 */
import crypto from "node:crypto";
import { SCHEMA_VERSION_SESSION, } from "../../../../../agents-comm-bus-core/dist/index.js";
import { ClaudeWakeRegistry } from "./wake.js";
const DEFAULT_TTL_SECONDS = 3600;
const CLAUDE_IPC_METHODS = new Set([
    "claude_register_session",
    "claude_drain_inbound",
    "claude_open_query",
]);
export class ClaudeBridge {
    options;
    agentId = "claude";
    ipcMethods = CLAUDE_IPC_METHODS;
    wake = new ClaudeWakeRegistry();
    constructor(options) {
        this.options = options;
        // pendingInboundMax preserved as an option for symmetry but the daemon
        // now caps the shared queue itself; this class only drains it.
        void options.pendingInboundMax;
    }
    /**
     * Wire Claude-specific behaviors into the bus + per-comm callbacks. The
     * shared dispatch sink (pendingInbound + onInboundConversation fan-out)
     * is set up by the daemon; here we only own resolve-on-sink (write the
     * wake response) and the inline-keyboard callback handler.
     */
    attach(comms) {
        this.options.bus.setResolveSink({
            onResolved: async (query, decision) => {
                if (query.agent !== this.agentId)
                    return;
                const payload = wakePayloadFromDecision(decision);
                if (!payload)
                    return;
                await this.wake.writeResponseForSession(query.session, payload);
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
        try {
            await this.wake.wakeConversation(conversation);
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to write Claude wake trigger for ` +
                `${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async handleIpcMethod(method, params, ctx) {
        switch (method) {
            case "claude_register_session":
                return this.registerSession(params, ctx.socket);
            case "claude_drain_inbound":
                return this.drainInbound(params);
            case "claude_open_query":
                return this.openQuery(params);
            default:
                throw new Error(`ClaudeBridge does not handle IPC method: ${method}`);
        }
    }
    /**
     * Drain pending-inbound entries addressed to this bridge's agent
     * (`conversation.agent === "claude"`). The queue is daemon-wide and
     * shared across bridges, so each agent must filter to its own
     * conversations — otherwise the first bridge to drain sweeps the queue
     * and starves the others. Entries for other agents (or unlabelled
     * entries, which are kept for back-compat) are left in place.
     */
    drainPendingInbound() {
        const drained = [];
        for (let i = this.options.pendingInbound.length - 1; i >= 0; i -= 1) {
            const entry = this.options.pendingInbound[i];
            const agent = entry.conversation?.agent;
            if (agent === undefined || agent === this.agentId) {
                drained.unshift(entry);
                this.options.pendingInbound.splice(i, 1);
            }
        }
        return drained;
    }
    async registerSession(params, socket) {
        const session = requiredString(params.session, "session");
        const project = requiredString(params.project, "project");
        const connectionId = typeof params.connection_id === "string"
            ? params.connection_id
            : `claude:${session}:${crypto.randomUUID()}`;
        const now = Date.now();
        const wakeDir = typeof params.wake_dir === "string"
            ? params.wake_dir
            : typeof params.wakeDir === "string"
                ? params.wakeDir
                : undefined;
        await this.options.storage.upsertSession({
            schema_version: SCHEMA_VERSION_SESSION,
            session_id: session,
            agent: "claude",
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
            return { ok: false, reason: "same-project claude session lease already held" };
        }
        const registration = this.wake.register({ session, project, wakeDir });
        socket?.once("close", () => {
            void this.options.storage.releaseSessionLease(session, connectionId, Date.now());
        });
        return { ok: true, wake_dir: registration.wakeDir };
    }
    async drainInbound(params) {
        const session = typeof params.session === "string" ? params.session : undefined;
        const drained = this.drainPendingInbound();
        if (session && drained.length > 0) {
            await this.options.storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id);
        }
        return drained;
    }
    async openQuery(params) {
        const session = requiredString(params.session, "session");
        const queryInput = recordOrEmpty(params.query);
        const claudeInput = recordOrEmpty(params.claude);
        const toolName = typeof params.tool_name === "string"
            ? params.tool_name
            : typeof claudeInput.tool_name === "string"
                ? claudeInput.tool_name
                : undefined;
        const promptText = requiredString(params.prompt_text ?? queryInput.prompt_text, "prompt_text");
        const rawKind = params.kind ?? queryInput.kind;
        const kind = rawKind === "choice" || rawKind === "freetext" || rawKind === "approval"
            ? rawKind
            : "approval";
        const queryId = `q_${crypto.randomUUID()}`;
        const sessionRecord = await this.options.storage.getSession(session);
        const conversation = sessionRecord?.most_recent_inbound_conversation_id
            ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
            : null;
        const originChat = conversation ? await this.chatRefForConversation(conversation) : undefined;
        const options = Array.isArray(params.options)
            ? params.options.map(String)
            : Array.isArray(queryInput.options)
                ? queryInput.options.map(String)
                : undefined;
        const query = {
            schema_version: 1,
            query_id: queryId,
            agent: "claude",
            session,
            kind,
            prompt_text: promptText,
            options,
            origin_chat: originChat,
            created_at: Date.now(),
            ttl_seconds: typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS,
        };
        await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
        await this.options.bus.openQuery(query);
        if (originChat) {
            const promptFormat = params.prompt_format ?? queryInput.prompt_format;
            const inlineKeyboard = inlineKeyboardForQuery(queryId, kind, options);
            await this.options.bus.send({
                session,
                comm: originChat.comm,
                target: originChat,
                payload: {
                    text: promptText,
                    format: promptFormat === "html" ? "html" : "plain",
                    inline_keyboard: inlineKeyboard,
                },
                idempotencyKey: `query:${queryId}`,
            });
        }
        const hookResponse = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
        return {
            query_id: queryId,
            hook_response: hookResponse,
            hookJson: hookResponse,
            nativeHookJson: hookResponse,
        };
    }
    async handleCommCallback(comm, event) {
        const parsed = parseCallbackData(event.data);
        if (!parsed) {
            if (comm.answerCallback) {
                await comm.answerCallback(event.callback_id, {
                    text: "Unrecognized button payload",
                });
            }
            return;
        }
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
        switch (outcome.kind) {
            case "resolved": {
                const text = ackTextFor(outcome.decision);
                await comm.answerCallback(event.callback_id, { text });
                if (comm.editMessage) {
                    try {
                        await comm.editMessage(event.chat_native_id, event.message_native_id, `✓ Resolved via Telegram (${text}).`);
                    }
                    catch {
                        // Best-effort UI polish; ignore failures.
                    }
                }
                return;
            }
            case "awaiting_freetext":
                await comm.answerCallback(event.callback_id, {
                    text: "Now send your custom reply as a message.",
                    showAlert: true,
                });
                if (comm.editMessage) {
                    try {
                        await comm.editMessage(event.chat_native_id, event.message_native_id, "💬 Awaiting your custom reply… (send any text in this chat).");
                    }
                    catch {
                        // Best-effort.
                    }
                }
                return;
            case "already_resolved":
                await comm.answerCallback(event.callback_id, {
                    text: "Already resolved.",
                    showAlert: false,
                });
                return;
            case "expired":
                await comm.answerCallback(event.callback_id, {
                    text: "This prompt expired before you answered.",
                    showAlert: true,
                });
                return;
            case "unknown_query":
                await comm.answerCallback(event.callback_id, {
                    text: "Unknown query.",
                });
                return;
            case "invalid_value":
                await comm.answerCallback(event.callback_id, {
                    text: `Unrecognized value: ${outcome.value}`,
                });
                return;
        }
    }
    async chatRefForConversation(conversation) {
        const registration = (await this.options.storage.listAccountRegistrations({
            project: conversation.project,
            comm: conversation.comm,
            agent: conversation.agent,
        })).find((candidate) => candidate.account_label === conversation.account_label);
        if (!registration)
            return undefined;
        return {
            comm: conversation.comm,
            account: registration.bot_user_id,
            chat_native_id: conversation.chat_native_id,
            thread_native_id: conversation.thread_native_id ?? undefined,
        };
    }
}
function inlineKeyboardForQuery(queryId, kind, options) {
    if (kind === "approval") {
        return [
            [
                { text: "✅ Allow", callback_data: `q:${queryId}:y` },
                { text: "❌ Deny", callback_data: `q:${queryId}:n` },
            ],
            [{ text: "🔓 Always", callback_data: `q:${queryId}:a` }],
        ];
    }
    if (kind === "choice") {
        const rows = (options ?? []).map((label, index) => [
            {
                text: `${index + 1}. ${truncateButtonText(label)}`,
                callback_data: `q:${queryId}:${index + 1}`,
            },
        ]);
        rows.push([
            { text: "💬 Other (type a reply)", callback_data: `q:${queryId}:other` },
        ]);
        return rows;
    }
    return undefined;
}
function truncateButtonText(label) {
    const trimmed = label.replace(/\s+/g, " ").trim();
    if (trimmed.length <= 48)
        return trimmed;
    return `${trimmed.slice(0, 47)}…`;
}
function wakePayloadFromDecision(decision) {
    switch (decision.decision) {
        case "allow":
            return { response: "y", prompt_type: "permission" };
        case "deny":
            return { response: "n", prompt_type: "permission" };
        case "always_allow":
            return { response: "a", prompt_type: "permission" };
        case "select_option": {
            const idx = decision.selected_option_index;
            if (typeof idx !== "number")
                return null;
            return { response: String(idx + 1), prompt_type: "question" };
        }
        case "text":
            if (!decision.text)
                return null;
            return { response: decision.text, prompt_type: "freetext" };
        default:
            return null;
    }
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
        case "deny":
            return "Denied";
        case "always_allow":
            return "Always allowed";
        case "select_option":
            return `Selected option ${typeof decision.selected_option_index === "number" ? decision.selected_option_index + 1 : "?"}`;
        case "text":
            return "Reply received";
        default:
            return "Recorded";
    }
}
function hookResponseForUnresolvedClaudeQuery(params) {
    if (params.tool_name === "AskUserQuestion") {
        return { decision: { behavior: "allow" } };
    }
    return { decision: { behavior: "ask" } };
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
export class ClaudeBridgeFactory {
    agentId = "claude";
    create(context) {
        return new ClaudeBridge({
            storage: context.storage,
            bus: context.bus,
            pendingInbound: context.pendingInbound,
        });
    }
}
//# sourceMappingURL=bridge.js.map
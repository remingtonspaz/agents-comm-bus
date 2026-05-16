#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { SCHEMA_VERSION_SESSION, } from "../../agents-comm-bus-core/dist/index.js";
import { DAEMON_VERSION } from "./config.js";
import { resolveStatePaths } from "./paths.js";
import { startIpcServer } from "./ipc/server.js";
import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
import { MessageBus } from "./bus.js";
import { TelegramCommAdapter } from "./adapters/comm/telegram.js";
import { ClaudeWakeRegistry } from "./adapters/agent/claude-wake.js";
import { openSqliteStorage } from "./storage/sqlite.js";
import { JsonlTranscriptStore } from "./storage/transcripts.js";
import { JsonlAuditStore } from "./storage/audit.js";
import { ContentAddressedBlobStore } from "./storage/blobs.js";
export async function main(argv = process.argv.slice(2)) {
    const paths = resolveStatePaths({ stateRoot: process.env.AGENTS_COMM_BUS_STATE_ROOT });
    if (argv.includes("--print-paths")) {
        console.log(JSON.stringify(paths, null, 2));
        return;
    }
    await mkdir(paths.root, { recursive: true });
    const storage = await openSqliteStorage(paths.database);
    const transcripts = new JsonlTranscriptStore(paths.root);
    const audit = new JsonlAuditStore(paths.root);
    const blobs = new ContentAddressedBlobStore(paths.root);
    const pendingInbound = [];
    const claudeWake = new ClaudeWakeRegistry();
    const comms = [];
    const attachedBotIds = new Set();
    const registrations = await storage.listAccountRegistrations({ comm: "telegram" });
    for (const registration of registrations) {
        if (attachedBotIds.has(registration.bot_user_id))
            continue;
        const resolved = await resolveTelegramCredentials(registration);
        if (!resolved) {
            console.error(`agents-comm-bus: skipping telegram account ${registration.account_label} ` +
                `for project ${registration.project} (could not resolve credentials_ref=${registration.credentials_ref})`);
            continue;
        }
        comms.push(new TelegramCommAdapter({
            botToken: resolved.botToken,
            allowedUserIds: resolved.allowedUserIds,
        }));
        attachedBotIds.add(registration.bot_user_id);
    }
    if (comms.length === 0) {
        const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        if (telegramToken) {
            comms.push(new TelegramCommAdapter({
                botToken: telegramToken,
                allowedUserIds: normalizeCsv(process.env.TELEGRAM_USER_ID),
            }));
        }
    }
    const bus = new MessageBus({
        project: process.cwd(),
        storage,
        transcripts,
        audit,
        blobs,
        comms,
    });
    bus.setDispatchSink({
        async enqueueInbound(message, conversation) {
            pendingInbound.push({ message, conversation });
            if (pendingInbound.length > 100)
                pendingInbound.splice(0, pendingInbound.length - 100);
            try {
                await claudeWake.wakeConversation(conversation);
            }
            catch (error) {
                console.error(`agents-comm-bus: failed to write Claude wake trigger for ` +
                    `${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    });
    bus.setResolveSink({
        async onResolved(query, decision) {
            const payload = wakePayloadFromDecision(decision);
            if (!payload)
                return;
            await claudeWake.writeResponseForSession(query.session, payload);
        },
    });
    for (const comm of comms) {
        if (typeof comm.onCallback === "function") {
            comm.onCallback(async (event) => {
                await handleCommCallback(comm, bus, event);
            });
        }
    }
    const server = await startIpcServer({
        metadata: {
            stateRoot: paths.root,
        },
        onRequest: async (request, socket) => handleIpcRequest(request, {
            bus,
            storage,
            pendingInbound,
            claudeWake,
            socket,
        }),
    });
    try {
        await writeDaemonDiscoveryFiles({ stateRoot: paths.root, port: server.port });
    }
    catch (error) {
        await server.close();
        throw error;
    }
    await bus.start();
    console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
}
async function handleIpcRequest(request, context) {
    const params = (request.params ?? {});
    switch (request.method) {
        case "list_conversations":
            return context.bus.listConversations({
                comm: params.comm,
                limit: typeof params.limit === "number" ? params.limit : 25,
            });
        case "telegram_check_messages": {
            const drained = context.pendingInbound.splice(0);
            return drained.map(({ message, conversation }) => ({ message, conversation }));
        }
        case "claude_register_session":
            return registerClaudeSession(context, params);
        case "claude_drain_inbound":
            return drainClaudeInbound(context, params);
        case "claude_open_query":
            return openClaudeQuery(context, params);
        case "telegram_send":
            return sendTelegram(context, params, false);
        case "telegram_send_image":
            return sendTelegram(context, params, true);
        default:
            throw new Error(`unknown IPC method: ${request.method}`);
    }
}
async function registerClaudeSession(context, params) {
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
    await context.storage.upsertSession({
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
    const acquired = await context.storage.acquireSessionLease(session, connectionId, now);
    if (!acquired) {
        return { ok: false, reason: "same-project claude session lease already held" };
    }
    const wake = context.claudeWake.register({ session, project, wakeDir });
    context.socket?.once("close", () => {
        void context.storage.releaseSessionLease(session, connectionId, Date.now());
    });
    return { ok: true, wake_dir: wake.wakeDir };
}
async function drainClaudeInbound(context, params) {
    const session = typeof params.session === "string" ? params.session : undefined;
    const drained = context.pendingInbound.splice(0);
    if (session && drained.length > 0) {
        await context.storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id);
    }
    return drained;
}
async function openClaudeQuery(context, params) {
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
    const kind = (rawKind === "choice" || rawKind === "freetext" || rawKind === "approval")
        ? rawKind
        : "approval";
    const queryId = `q_${crypto.randomUUID()}`;
    const sessionRecord = await context.storage.getSession(session);
    const conversation = sessionRecord?.most_recent_inbound_conversation_id
        ? await context.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
        : null;
    const originChat = conversation ? {
        comm: conversation.comm,
        account: conversation.account_label,
        chat_native_id: conversation.chat_native_id,
        thread_native_id: conversation.thread_native_id ?? undefined,
    } : undefined;
    const query = {
        schema_version: 1,
        query_id: queryId,
        agent: "claude",
        session,
        kind,
        prompt_text: promptText,
        options: Array.isArray(params.options)
            ? params.options.map(String)
            : Array.isArray(queryInput.options)
                ? queryInput.options.map(String)
                : undefined,
        origin_chat: originChat,
        created_at: Date.now(),
        ttl_seconds: typeof params.ttl_seconds === "number" ? params.ttl_seconds : 3600,
    };
    await context.storage.supersedeOpenQueriesForSession(session, Date.now());
    await context.bus.openQuery(query);
    if (originChat) {
        const promptFormat = params.prompt_format ?? queryInput.prompt_format;
        const inlineKeyboard = inlineKeyboardForQuery(queryId, kind, query.options);
        await context.bus.send({
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
async function sendTelegram(context, params, image) {
    const target = params.chat_id == null ? undefined : await targetFromParams(context.storage, params);
    const sent = await context.bus.send({
        session: String(params.session ?? "mcp"),
        comm: "telegram",
        target,
        payload: image
            ? {
                text: typeof params.caption === "string" ? params.caption : undefined,
                attachments: [{
                        filename: String(params.path),
                        local_path: String(params.path),
                        mime: "application/octet-stream",
                        size: 0,
                    }],
            }
            : { text: String(params.message ?? "") },
        idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
    });
    return { message_id: sent };
}
async function targetFromParams(storage, params) {
    if (params.chat_id == null) {
        throw new Error("omitted Telegram target requires a session most-recent-inbound conversation");
    }
    const registration = (await storage.listAccountRegistrations({
        comm: "telegram",
    }))[0];
    if (!registration) {
        throw new Error("no Telegram account registration exists; run agents-comm-bus account-add first");
    }
    return {
        comm: "telegram",
        account: registration.bot_user_id,
        chat_native_id: String(params.chat_id),
        thread_native_id: params.message_thread_id == null ? undefined : String(params.message_thread_id),
    };
}
function normalizeCsv(value) {
    return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
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
async function handleCommCallback(comm, bus, event) {
    const parsed = parseCallbackData(event.data);
    if (!parsed) {
        if (comm.answerCallback) {
            await comm.answerCallback(event.callback_id, {
                text: "Unrecognized button payload",
            });
        }
        return;
    }
    const chat = {
        comm: comm.id,
        account: "",
        chat_native_id: event.chat_native_id,
    };
    const outcome = await bus.resolveQueryFromCallback({
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
async function resolveTelegramCredentials(registration) {
    const ref = registration.credentials_ref ?? "";
    const envAllowed = normalizeCsv(process.env.TELEGRAM_USER_ID);
    if (ref.startsWith("env:")) {
        const name = ref.slice("env:".length);
        const fromEnv = name ? process.env[name] : undefined;
        if (fromEnv) {
            return { botToken: fromEnv, allowedUserIds: envAllowed };
        }
        const fromFile = await readProjectTelegramConfig(registration.project);
        if (fromFile?.botToken) {
            return {
                botToken: fromFile.botToken,
                allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
            };
        }
        return undefined;
    }
    if (ref.startsWith("file:")) {
        const fromFile = await readJsonTelegramConfig(ref.slice("file:".length));
        if (fromFile?.botToken) {
            return {
                botToken: fromFile.botToken,
                allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
            };
        }
        return undefined;
    }
    return undefined;
}
async function readProjectTelegramConfig(project) {
    return readJsonTelegramConfig(path.join(project, ".claude", "telegram.json"));
}
async function readJsonTelegramConfig(filePath) {
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const botToken = typeof parsed.botToken === "string" ? parsed.botToken : undefined;
        const userId = typeof parsed.userId === "string"
            ? parsed.userId
            : typeof parsed.userId === "number"
                ? String(parsed.userId)
                : undefined;
        if (!botToken && !userId)
            return undefined;
        return { botToken, userId };
    }
    catch {
        return undefined;
    }
}
function mergeAllowed(fromEnv, fromFile) {
    if (!fromFile)
        return fromEnv;
    return fromEnv.includes(fromFile) ? fromEnv : [...fromEnv, fromFile];
}
function requiredString(paramsValue, name) {
    if (typeof paramsValue !== "string" || paramsValue.length === 0) {
        throw new Error(`${name} is required`);
    }
    return paramsValue;
}
function hookResponseForUnresolvedClaudeQuery(params) {
    if (params.tool_name === "AskUserQuestion") {
        return { decision: { behavior: "allow" } };
    }
    return { decision: { behavior: "ask" } };
}
function recordOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=daemon.js.map
#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { DAEMON_VERSION } from "./config.js";
import { resolveStatePaths } from "./paths.js";
import { startIpcServer } from "./ipc/server.js";
import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
import { MessageBus } from "./bus.js";
import { TelegramCommAdapter } from "./adapters/comm/telegram.js";
import { ClaudeBridge } from "./adapters/agent/claude-bridge.js";
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
    const claude = new ClaudeBridge({ storage, bus, pendingInbound });
    claude.attach(comms);
    const server = await startIpcServer({
        metadata: { stateRoot: paths.root },
        onRequest: async (request, socket) => handleIpcRequest(request, { bus, storage, claude, socket }),
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
        case "telegram_check_messages":
            return context.claude.drainPendingInbound();
        case "claude_register_session":
            return context.claude.registerSession(params, context.socket);
        case "claude_drain_inbound":
            return context.claude.drainInbound(params);
        case "claude_open_query":
            return context.claude.openQuery(params);
        case "telegram_send":
            return sendTelegram(context, params, false);
        case "telegram_send_image":
            return sendTelegram(context, params, true);
        default:
            throw new Error(`unknown IPC method: ${request.method}`);
    }
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=daemon.js.map
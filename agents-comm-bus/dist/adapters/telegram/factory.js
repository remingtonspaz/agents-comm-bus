/**
 * Telegram comm adapter factory + IPC method surface.
 *
 * Concentrates everything Telegram-specific in one place so daemon.ts can
 * stay adapter-agnostic. Owns:
 *   - credential resolution from account_registrations (`file:` refs)
 *   - runtime allowlist union from env CSV + DB rows
 *   - the MCP-tool IPC method surface: telegram_send, telegram_send_image,
 *     telegram_check_messages
 */
import { readFile } from "node:fs/promises";
import { TelegramCommAdapter, probeTelegramIdentity } from "./adapter.js";
const TELEGRAM_COMM_ID = "telegram";
export class TelegramCommAdapterFactory {
    commId = TELEGRAM_COMM_ID;
    async resolveCredentials(registration, env, context) {
        const ref = registration.credentials_ref ?? "";
        const envAllowed = normalizeCsv(env.TELEGRAM_USER_ID);
        const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
        if (ref.startsWith("file:")) {
            const fromFile = await readJsonTelegramConfig(ref.slice("file:".length));
            if (fromFile?.botToken) {
                return {
                    credentials: {
                        botToken: fromFile.botToken,
                        allowedUserIds: mergeAllowed(envAllowed, fromFile.userId, dbAllowed),
                    },
                };
            }
            return undefined;
        }
        return undefined;
    }
    async probeIdentity(credentials) {
        const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
        if (!botToken) {
            throw new Error("TelegramCommAdapterFactory.probeIdentity: credentials.botToken is required");
        }
        const identity = await probeTelegramIdentity(botToken);
        return {
            accountId: identity.bot_user_id,
            accountUsername: identity.bot_username ?? null,
        };
    }
    create(credentials, accountId, context) {
        const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
        if (!botToken) {
            throw new Error("TelegramCommAdapterFactory.create: credentials.botToken is required");
        }
        const allowed = Array.isArray(credentials.allowedUserIds)
            ? credentials.allowedUserIds.map(String)
            : [];
        return new TelegramCommAdapter({
            botToken,
            accountId,
            allowedUserIds: allowed,
            attachmentBlobStore: context?.blobs,
        });
    }
    ipcMethods(deps) {
        return new Map([
            [
                "telegram_send",
                async (params) => sendTelegram(deps, params, false),
            ],
            [
                "telegram_send_image",
                async (params) => sendTelegram(deps, params, true),
            ],
            [
                "telegram_check_messages",
                async () => deps.pendingInbound.splice(0),
            ],
        ]);
    }
}
export function createCommAdapterFactory() {
    return new TelegramCommAdapterFactory();
}
async function sendTelegram(deps, params, image) {
    const chatNativeId = extractChatNativeId(params);
    const target = chatNativeId === null
        ? undefined
        : await targetFromParams(deps.storage, params, chatNativeId);
    const sent = await deps.bus.send({
        session: String(params.session ?? "mcp"),
        comm: TELEGRAM_COMM_ID,
        target,
        payload: image
            ? {
                text: typeof params.caption === "string" ? params.caption : undefined,
                attachments: [
                    {
                        filename: String(params.path),
                        local_path: String(params.path),
                        mime: "application/octet-stream",
                        size: 0,
                    },
                ],
            }
            : { text: String(params.message ?? "") },
        idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
    });
    return { message_id: sent };
}
/**
 * Pull the chat identifier from either the generic nested `target.chat_native_id`
 * shape (the form the comm-agnostic MCP shim sends) or the legacy flat `chat_id`
 * shape (still accepted for callers that haven't migrated). Returns `null` when
 * neither form is present — caller should fall back to the session's
 * most-recent-inbound conversation.
 */
function extractChatNativeId(params) {
    if (params.chat_id != null)
        return String(params.chat_id);
    const target = params.target;
    if (target && typeof target === "object" && "chat_native_id" in target) {
        const value = target.chat_native_id;
        if (value != null)
            return String(value);
    }
    return null;
}
function extractThreadNativeId(params) {
    if (params.message_thread_id != null)
        return String(params.message_thread_id);
    const target = params.target;
    if (target && typeof target === "object" && "thread_native_id" in target) {
        const value = target.thread_native_id;
        if (value != null)
            return String(value);
    }
    return undefined;
}
async function targetFromParams(storage, params, chatNativeId) {
    const explicitAccount = extractTargetAccount(params);
    if (explicitAccount != null) {
        return {
            comm: TELEGRAM_COMM_ID,
            account: explicitAccount,
            chat_native_id: chatNativeId,
            thread_native_id: extractThreadNativeId(params),
        };
    }
    const session = typeof params.session === "string"
        ? await storage.getSession(params.session)
        : null;
    const scoped = session
        ? await storage.listAccountRegistrations({
            project: session.project,
            comm: TELEGRAM_COMM_ID,
            agent: session.agent,
        })
        : [];
    const registration = scoped[0] ?? (await storage.listAccountRegistrations({ comm: TELEGRAM_COMM_ID }))[0];
    if (!registration) {
        throw new Error("no Telegram account registration exists; run agents-comm-bus account-add first");
    }
    return {
        comm: TELEGRAM_COMM_ID,
        account: registration.bot_user_id,
        chat_native_id: chatNativeId,
        thread_native_id: extractThreadNativeId(params),
    };
}
function extractTargetAccount(params) {
    const target = params.target;
    if (target && typeof target === "object" && "account" in target) {
        const value = target.account;
        if (value != null)
            return String(value);
    }
    return undefined;
}
function normalizeCsv(value) {
    return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
function mergeAllowed(fromEnv, fromFile, fromDb = undefined) {
    const out = [...fromEnv];
    const sources = [fromFile, fromDb];
    for (const source of sources) {
        if (!source)
            continue;
        for (const id of source) {
            if (!out.includes(id))
                out.push(id);
        }
    }
    return out;
}
async function readAllowlistFromDb(context, bot_user_id) {
    if (!context?.storage)
        return [];
    const [globals, perBot] = await Promise.all([
        context.storage.listAllowlistGlobal({ comm: TELEGRAM_COMM_ID }),
        context.storage.listAllowlistPerBot({ comm: TELEGRAM_COMM_ID, bot_user_id }),
    ]);
    const out = [];
    for (const row of globals) {
        if (!out.includes(row.sender_id))
            out.push(row.sender_id);
    }
    for (const row of perBot) {
        if (!out.includes(row.sender_id))
            out.push(row.sender_id);
    }
    return out;
}
async function readJsonTelegramConfig(filePath) {
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const botToken = typeof parsed.botToken === "string" ? parsed.botToken : undefined;
        const userId = normalizeUserIdField(parsed.userId);
        if (!botToken && userId.length === 0)
            return undefined;
        return { botToken, userId: userId.length > 0 ? userId : undefined };
    }
    catch {
        return undefined;
    }
}
function normalizeUserIdField(raw) {
    if (raw == null)
        return [];
    if (Array.isArray(raw)) {
        return raw
            .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : ""))
            .map((s) => s.trim())
            .filter(Boolean);
    }
    if (typeof raw === "string")
        return [raw.trim()].filter(Boolean);
    if (typeof raw === "number")
        return [String(raw)];
    return [];
}
//# sourceMappingURL=factory.js.map
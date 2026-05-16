/**
 * Telegram comm adapter factory + IPC method surface.
 *
 * Concentrates everything Telegram-specific in one place so daemon.ts can
 * stay adapter-agnostic. Owns:
 *   - credential resolution from account_registrations (env / file refs)
 *   - dev-mode env fallback (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_USER_ID`)
 *   - the project-local `.claude/telegram.json` reader (legacy convention)
 *   - the MCP-tool IPC method surface: telegram_send, telegram_send_image,
 *     telegram_check_messages
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TelegramCommAdapter } from "./adapter.js";
const TELEGRAM_COMM_ID = "telegram";
export class TelegramCommAdapterFactory {
    commId = TELEGRAM_COMM_ID;
    async resolveCredentials(registration, env) {
        const ref = registration.credentials_ref ?? "";
        const envAllowed = normalizeCsv(env.TELEGRAM_USER_ID);
        if (ref.startsWith("env:")) {
            const name = ref.slice("env:".length);
            const fromEnv = name ? env[name] : undefined;
            if (fromEnv) {
                return { credentials: { botToken: fromEnv, allowedUserIds: envAllowed } };
            }
            const fromFile = await readProjectTelegramConfig(registration.project);
            if (fromFile?.botToken) {
                return {
                    credentials: {
                        botToken: fromFile.botToken,
                        allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
                    },
                };
            }
            return undefined;
        }
        if (ref.startsWith("file:")) {
            const fromFile = await readJsonTelegramConfig(ref.slice("file:".length));
            if (fromFile?.botToken) {
                return {
                    credentials: {
                        botToken: fromFile.botToken,
                        allowedUserIds: mergeAllowed(envAllowed, fromFile.userId),
                    },
                };
            }
            return undefined;
        }
        return undefined;
    }
    fallbackFromEnv(env) {
        const token = env.TELEGRAM_BOT_TOKEN;
        if (!token)
            return undefined;
        return {
            credentials: {
                botToken: token,
                allowedUserIds: normalizeCsv(env.TELEGRAM_USER_ID),
            },
        };
    }
    create(credentials) {
        const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
        if (!botToken) {
            throw new Error("TelegramCommAdapterFactory.create: credentials.botToken is required");
        }
        const allowed = Array.isArray(credentials.allowedUserIds)
            ? credentials.allowedUserIds.map(String)
            : [];
        return new TelegramCommAdapter({ botToken, allowedUserIds: allowed });
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
async function sendTelegram(deps, params, image) {
    const target = params.chat_id == null
        ? undefined
        : await targetFromParams(deps.storage, params);
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
async function targetFromParams(storage, params) {
    if (params.chat_id == null) {
        throw new Error("omitted Telegram target requires a session most-recent-inbound conversation");
    }
    const registration = (await storage.listAccountRegistrations({ comm: TELEGRAM_COMM_ID }))[0];
    if (!registration) {
        throw new Error("no Telegram account registration exists; run agents-comm-bus account-add first");
    }
    return {
        comm: TELEGRAM_COMM_ID,
        account: registration.bot_user_id,
        chat_native_id: String(params.chat_id),
        thread_native_id: params.message_thread_id == null ? undefined : String(params.message_thread_id),
    };
}
function normalizeCsv(value) {
    return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
function mergeAllowed(fromEnv, fromFile) {
    if (!fromFile)
        return fromEnv;
    return fromEnv.includes(fromFile) ? fromEnv : [...fromEnv, fromFile];
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
//# sourceMappingURL=factory.js.map
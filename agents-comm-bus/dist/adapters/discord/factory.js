/**
 * Discord comm adapter factory + IPC method surface.
 */
import { readFile } from "node:fs/promises";
import { DiscordCommAdapter, probeDiscordIdentity } from "./adapter.js";
const DISCORD_COMM_ID = "discord";
export class DiscordCommAdapterFactory {
    commId = DISCORD_COMM_ID;
    async resolveCredentials(registration, env, context) {
        const ref = registration.credentials_ref ?? "";
        if (!ref.startsWith("file:")) {
            return undefined;
        }
        const envAllowed = normalizeCsv(env.DISCORD_USER_ID);
        const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
        const fromFile = await readJsonDiscordConfig(ref.slice("file:".length));
        if (!fromFile?.botToken) {
            return undefined;
        }
        return {
            credentials: {
                botToken: fromFile.botToken,
                allowedUserIds: mergeAllowed(envAllowed, fromFile.userId, dbAllowed),
            },
        };
    }
    async probeIdentity(credentials) {
        const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
        if (!botToken) {
            throw new Error("DiscordCommAdapterFactory.probeIdentity: credentials.botToken is required");
        }
        const identity = await probeDiscordIdentity(botToken);
        return {
            accountId: identity.bot_user_id,
            accountUsername: identity.bot_username ?? null,
        };
    }
    create(credentials, accountId, _context) {
        const botToken = typeof credentials.botToken === "string" ? credentials.botToken : null;
        if (!botToken) {
            throw new Error("DiscordCommAdapterFactory.create: credentials.botToken is required");
        }
        const applicationId = typeof credentials.applicationId === "string" ? credentials.applicationId : undefined;
        const allowed = Array.isArray(credentials.allowedUserIds)
            ? credentials.allowedUserIds.map(String)
            : [];
        return new DiscordCommAdapter({
            botToken,
            applicationId,
            accountId,
            allowedUserIds: allowed,
        });
    }
    ipcMethods(deps) {
        return new Map([
            [
                "discord_send",
                async (params) => sendDiscord(deps, params),
            ],
        ]);
    }
}
export function createCommAdapterFactory() {
    return new DiscordCommAdapterFactory();
}
async function sendDiscord(deps, params) {
    const chatNativeId = extractChatNativeId(params);
    const target = chatNativeId === null
        ? undefined
        : await targetFromParams(deps.storage, params, chatNativeId);
    const sent = await deps.bus.send({
        session: String(params.session ?? "mcp"),
        comm: DISCORD_COMM_ID,
        target,
        payload: { text: String(params.message ?? "") },
        idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
    });
    return { message_id: sent };
}
function extractChatNativeId(params) {
    if (params.channel_id != null)
        return String(params.channel_id);
    const target = params.target;
    if (target && typeof target === "object" && "chat_native_id" in target) {
        const value = target.chat_native_id;
        if (value != null)
            return String(value);
    }
    return null;
}
async function targetFromParams(storage, params, chatNativeId) {
    const explicitAccount = extractTargetAccount(params);
    if (explicitAccount != null) {
        rejectAccountLabel(explicitAccount);
        return {
            comm: DISCORD_COMM_ID,
            account: explicitAccount,
            chat_native_id: chatNativeId,
        };
    }
    const session = typeof params.session === "string"
        ? await storage.getSession(params.session)
        : null;
    const scoped = session
        ? await storage.listAccountRegistrations({
            project: session.project,
            comm: DISCORD_COMM_ID,
            agent: session.agent,
        })
        : [];
    const registration = scoped[0] ?? (await storage.listAccountRegistrations({ comm: DISCORD_COMM_ID }))[0];
    if (!registration) {
        throw new Error("no Discord account registration exists; run agents-comm account-add first");
    }
    return {
        comm: DISCORD_COMM_ID,
        account: registration.bot_user_id,
        chat_native_id: chatNativeId,
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
function rejectAccountLabel(account) {
    if (!/^\d+$/.test(account)) {
        throw new Error(`target.account "${account}" is not a registered bot id — labels like "main" are not accepted; ` +
            `use the concrete bot_user_id from account-add or list_conversations`);
    }
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
        context.storage.listAllowlistGlobal({ comm: DISCORD_COMM_ID }),
        context.storage.listAllowlistPerBot({ comm: DISCORD_COMM_ID, bot_user_id }),
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
async function readJsonDiscordConfig(filePath) {
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const botToken = typeof parsed.botToken === "string"
            ? parsed.botToken
            : typeof parsed.bot_token === "string"
                ? parsed.bot_token
                : undefined;
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
import { readFile } from "node:fs/promises";
import { isMatrixMxid, MatrixCommAdapter, probeMatrixIdentity, } from "./adapter.js";
const MATRIX_COMM_ID = "matrix";
export class MatrixCommAdapterFactory {
    options;
    commId = MATRIX_COMM_ID;
    constructor(options = {}) {
        this.options = options;
    }
    async resolveCredentials(registration, env, context) {
        const ref = registration.credentials_ref ?? "";
        if (!ref.startsWith("file:"))
            return undefined;
        const fromFile = await readJsonMatrixConfig(ref.slice("file:".length));
        if (!fromFile)
            return undefined;
        const envAllowed = normalizeCsv(env.MATRIX_USER_ID);
        const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
        return {
            credentials: {
                homeserverUrl: fromFile.homeserverUrl,
                accessToken: fromFile.accessToken,
                userId: fromFile.userId,
                deviceId: fromFile.deviceId,
                allowedUserIds: mergeAllowed(envAllowed, fromFile.allowedUserIds, dbAllowed),
                allowedRoomIds: fromFile.allowedRoomIds ?? [],
                autoJoinInvites: fromFile.autoJoinInvites ?? false,
                encryptedRoomPolicy: fromFile.encryptedRoomPolicy ?? "decline",
            },
        };
    }
    async probeIdentity(credentials) {
        const parsed = parseResolvedCredentials(credentials);
        const identity = await probeMatrixIdentity(parsed.homeserverUrl, parsed.accessToken, parsed.userId, this.options.identityClient);
        return {
            accountId: identity.user_id,
            accountUsername: identity.localpart,
        };
    }
    create(credentials, accountId, _context) {
        const parsed = parseResolvedCredentials(credentials);
        return new MatrixCommAdapter({
            homeserverUrl: parsed.homeserverUrl,
            accessToken: parsed.accessToken,
            userId: parsed.userId,
            accountId,
            deviceId: parsed.deviceId,
            allowedUserIds: parsed.allowedUserIds,
            allowedRoomIds: parsed.allowedRoomIds,
            autoJoinInvites: parsed.autoJoinInvites,
            encryptedRoomPolicy: parsed.encryptedRoomPolicy,
        });
    }
    ipcMethods(deps) {
        return new Map([
            [
                "matrix_send",
                async (params) => sendMatrix(deps, params),
            ],
        ]);
    }
}
export function createCommAdapterFactory(options) {
    return new MatrixCommAdapterFactory(options);
}
async function sendMatrix(deps, params) {
    const chatNativeId = extractChatNativeId(params);
    const target = chatNativeId === null
        ? undefined
        : await targetFromParams(deps.storage, params, chatNativeId);
    const sent = await deps.bus.send({
        session: String(params.session ?? "mcp"),
        comm: MATRIX_COMM_ID,
        target,
        payload: { text: String(params.message ?? "") },
        idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : undefined,
    });
    return { message_id: sent };
}
function extractChatNativeId(params) {
    if (params.room_id != null)
        return String(params.room_id);
    const target = params.target;
    if (target && typeof target === "object" && "chat_native_id" in target) {
        const value = target.chat_native_id;
        if (value != null)
            return String(value);
    }
    if (target && typeof target === "object" && "room_id" in target) {
        const value = target.room_id;
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
            comm: MATRIX_COMM_ID,
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
            comm: MATRIX_COMM_ID,
            agent: session.agent,
        })
        : [];
    const registration = scoped[0] ?? (await storage.listAccountRegistrations({ comm: MATRIX_COMM_ID }))[0];
    if (!registration) {
        throw new Error("no Matrix account registration exists; run agents-comm account-add first");
    }
    return {
        comm: MATRIX_COMM_ID,
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
    if (!isMatrixMxid(account)) {
        throw new Error(`target.account "${account}" is not a Matrix MXID — labels like "main" are not accepted; ` +
            `use the concrete bot_user_id (MXID) from account-add or list_conversations`);
    }
}
function parseResolvedCredentials(credentials) {
    const homeserverUrl = typeof credentials.homeserverUrl === "string"
        ? credentials.homeserverUrl
        : null;
    const accessToken = typeof credentials.accessToken === "string"
        ? credentials.accessToken
        : null;
    const userId = typeof credentials.userId === "string" ? credentials.userId : null;
    if (!homeserverUrl || !accessToken || !userId) {
        throw new Error("MatrixCommAdapterFactory: credentials.homeserverUrl, accessToken, and userId are required");
    }
    return {
        homeserverUrl,
        accessToken,
        userId,
        deviceId: typeof credentials.deviceId === "string" ? credentials.deviceId : undefined,
        allowedUserIds: normalizeStringArray(credentials.allowedUserIds),
        allowedRoomIds: normalizeStringArray(credentials.allowedRoomIds),
        autoJoinInvites: credentials.autoJoinInvites === true,
        encryptedRoomPolicy: credentials.encryptedRoomPolicy === "decline" ? "decline" : "decline",
    };
}
function normalizeHomeserverUrl(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    return trimmed.replace(/\/+$/, "");
}
function normalizeStringArray(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
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
        context.storage.listAllowlistGlobal({ comm: MATRIX_COMM_ID }),
        context.storage.listAllowlistPerBot({ comm: MATRIX_COMM_ID, bot_user_id }),
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
async function readJsonMatrixConfig(filePath) {
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const homeserverUrl = typeof parsed.homeserverUrl === "string"
            ? normalizeHomeserverUrl(parsed.homeserverUrl)
            : undefined;
        const accessToken = typeof parsed.accessToken === "string"
            ? parsed.accessToken.trim()
            : undefined;
        const userId = typeof parsed.userId === "string" ? parsed.userId.trim() : undefined;
        if (!homeserverUrl || !accessToken || !userId || !isMatrixMxid(userId)) {
            return undefined;
        }
        const encryptedRoomPolicy = parsed.encryptedRoomPolicy === "decline"
            ? "decline"
            : parsed.encryptedRoomPolicy == null
                ? "decline"
                : undefined;
        if (encryptedRoomPolicy == null)
            return undefined;
        return {
            homeserverUrl,
            accessToken,
            userId,
            deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
            allowedUserIds: normalizeStringArray(parsed.allowedUserIds),
            allowedRoomIds: normalizeStringArray(parsed.allowedRoomIds),
            autoJoinInvites: parsed.autoJoinInvites === true,
            encryptedRoomPolicy,
        };
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=factory.js.map
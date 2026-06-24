import { readCredentialFile, } from "../../core-daemon/runtime/credential-resolution.js";
import { CurlCommAdapter } from "./adapter.js";
const CURL_COMM_ID = "curl";
export const DEFAULT_CURL_ACCOUNT_ID = "curl:local";
export class CurlCommAdapterFactory {
    commId = CURL_COMM_ID;
    async resolveCredentials(registration, env, context) {
        const ref = registration.credentials_ref ?? "";
        if (!ref.startsWith("file:"))
            return { status: "absent" };
        const fileResult = await readCredentialFile(ref);
        if (fileResult.status !== "ok") {
            return fileResult;
        }
        const parsed = fileResult.json;
        const token = typeof parsed.botToken === "string" && parsed.botToken.trim().length > 0
            ? parsed.botToken
            : typeof parsed.token === "string" && parsed.token.trim().length > 0
                ? parsed.token
                : undefined;
        if (!token) {
            return {
                status: "invalid",
                failureKind: "missing_field",
                reason: "missing required field: token",
                path: fileResult.path,
            };
        }
        const port = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0
            ? parsed.port
            : undefined;
        const envAllowed = normalizeCsv(env.CURL_SENDER_ID);
        const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
        const userId = normalizeUserIdField(parsed.userId);
        return {
            status: "ok",
            credentials: {
                token,
                port,
                project: registration.project,
                agent: registration.agent,
                allowedSenderIds: mergeAllowed(envAllowed, userId.length > 0 ? userId : undefined, dbAllowed),
            },
        };
    }
    async probeIdentity(credentials) {
        const token = typeof credentials.botToken === "string" ? credentials.botToken : null;
        if (!token || token.trim().length === 0) {
            throw new Error("CurlCommAdapterFactory.probeIdentity: credentials.botToken is required");
        }
        const explicit = typeof credentials.accountId === "string" ? credentials.accountId.trim() : "";
        if (explicit && /\s/.test(explicit)) {
            throw new Error(`CurlCommAdapterFactory.probeIdentity: explicit account id "${explicit}" must not contain whitespace`);
        }
        return {
            accountId: (explicit || DEFAULT_CURL_ACCOUNT_ID),
            accountUsername: null,
        };
    }
    create(credentials, accountId, context) {
        const token = typeof credentials.token === "string" ? credentials.token : null;
        const project = typeof credentials.project === "string" ? credentials.project : null;
        const agent = typeof credentials.agent === "string" ? credentials.agent : null;
        if (!token || !project || !agent) {
            throw new Error("CurlCommAdapterFactory.create: credentials.token, project, and agent are required");
        }
        const allowed = Array.isArray(credentials.allowedSenderIds)
            ? credentials.allowedSenderIds.map(String)
            : [];
        return new CurlCommAdapter({
            token,
            accountId,
            project,
            agent,
            port: typeof credentials.port === "number" && Number.isInteger(credentials.port)
                ? credentials.port
                : undefined,
            allowedSenderIds: allowed,
            stateRoot: context?.stateRoot,
        });
    }
    /**
     * Outbound IPC surface exists only to fail loudly: the generic MCP shim
     * maps `comm_send_message` → `curl_send`, and without these handlers a
     * misrouted send dies with a cryptic "unknown method" instead of the
     * inbound-only diagnostic the spec calls for.
     */
    ipcMethods(_deps) {
        const rejectOutbound = (operation) => async () => {
            throw new Error(`curl comm is local inbound-only (AGE-50 V1): ${operation} is not supported. ` +
                `Inject context by POSTing to the local /messages endpoint; reply over a ` +
                `bidirectional comm (telegram/discord/matrix) instead.`);
        };
        return new Map([
            ["curl_send", rejectOutbound("outbound send")],
            ["curl_send_image", rejectOutbound("outbound attachments")],
        ]);
    }
}
export function createCommAdapterFactory() {
    return new CurlCommAdapterFactory();
}
function normalizeUserIdField(raw) {
    if (raw == null)
        return [];
    if (Array.isArray(raw)) {
        return raw
            .map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : ""))
            .map((value) => value.trim())
            .filter(Boolean);
    }
    if (typeof raw === "string")
        return [raw.trim()].filter(Boolean);
    if (typeof raw === "number")
        return [String(raw)];
    return [];
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
        context.storage.listAllowlistGlobal({ comm: CURL_COMM_ID }),
        context.storage.listAllowlistPerBot({ comm: CURL_COMM_ID, bot_user_id }),
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
//# sourceMappingURL=factory.js.map
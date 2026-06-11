/**
 * Curl comm adapter (AGE-50): local POST ingress to agent context.
 *
 * Deliberately dumb V1: inbound only, local only, curl-friendly. A loopback
 * HTTP server accepts `POST /messages` with a bearer token and converts the
 * body into a normal inbound `Message` dispatched through the existing bus
 * path (transcript/audit, pendingInbound, bridge wake trigger, drain into
 * `[Daemon Inbound Messages]`). There is no outbound, no callbacks, no
 * polling — `send()` rejects loudly.
 *
 * Example:
 *   curl -s -X POST "http://127.0.0.1:$(jq -r .port endpoint.json)/messages" \
 *     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 *     -d '{"project":"D:/proj","agent":"claude","sender_id":"ci","text":"build green"}'
 */
import crypto from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
export const CURL_LOOPBACK_HOST = "127.0.0.1";
export const CURL_MESSAGES_PATH = "/messages";
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** Deterministic synthetic conversation key when the caller omits `chat_native_id`. */
export function syntheticChatNativeId(senderId) {
    return `curl:${senderId}`;
}
/** Filesystem-safe folder name for an account id like `curl:local`. */
export function sanitizeAccountIdForPath(accountId) {
    return accountId.replace(/[^A-Za-z0-9._-]+/g, "-");
}
export function curlEndpointFilePath(stateRoot, accountId) {
    return path.join(stateRoot, "curl", sanitizeAccountIdForPath(accountId), "endpoint.json");
}
/**
 * Validate a decoded POST body. Returns the parsed shape or a caller-facing
 * error string (HTTP 400) — never throws.
 */
export function parseCurlPostBody(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: "body must be a JSON object" };
    }
    const record = raw;
    for (const field of ["project", "agent", "sender_id", "text"]) {
        const value = record[field];
        if (typeof value !== "string" || value.trim().length === 0) {
            return { error: `body.${field} is required and must be a non-empty string` };
        }
    }
    if (record.chat_native_id != null && typeof record.chat_native_id !== "string") {
        return { error: "body.chat_native_id must be a string when present" };
    }
    if (record.metadata != null &&
        (typeof record.metadata !== "object" || Array.isArray(record.metadata))) {
        return { error: "body.metadata must be a JSON object when present" };
    }
    return {
        body: {
            project: record.project,
            agent: record.agent,
            sender_id: record.sender_id.trim(),
            text: record.text,
            chat_native_id: typeof record.chat_native_id === "string" && record.chat_native_id.length > 0
                ? record.chat_native_id
                : undefined,
            metadata: record.metadata,
        },
    };
}
/** Constant-time bearer-token check over the `Authorization` header. */
export function isAuthorizedCurlRequest(authorizationHeader, token) {
    const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
    if (!match)
        return false;
    const presented = crypto.createHash("sha256").update(match[1]).digest();
    const expected = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(presented, expected);
}
export class CurlCommAdapter {
    options;
    id = "curl";
    accountId;
    now;
    log;
    filterTrace;
    maxBodyBytes;
    normalizedProject;
    allowedSenders;
    inboundHandler = null;
    filterDropHandler = null;
    stateHandler = null;
    connectionState = null;
    server = null;
    boundPort = null;
    constructor(options) {
        this.options = options;
        if (!options.token) {
            throw new Error("CurlCommAdapter: a non-empty token is required");
        }
        this.accountId = options.accountId;
        this.now = options.now ?? Date.now;
        this.log = options.log ?? ((message) => console.error(message));
        this.filterTrace = options.filterTrace ?? process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1";
        this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
        this.normalizedProject = normalizeProjectPath(options.project);
        this.allowedSenders = new Set(options.allowedSenderIds ?? []);
    }
    get allowedSenderIds() {
        return Array.from(this.allowedSenders);
    }
    updateAllowedSenderIds(ids) {
        this.allowedSenders = new Set(ids);
    }
    /** Bound loopback port once started (ephemeral binds resolve here). */
    get port() {
        return this.boundPort;
    }
    /**
     * One live HTTP listener per registration: a second daemon serving the same
     * curl account would race for the port (or silently split discovery files),
     * so the account id is the exclusive single-consumer resource.
     */
    exclusiveResource() {
        return { resourceId: String(this.accountId) };
    }
    async start() {
        this.emitState("connecting");
        const server = createServer((req, res) => {
            void this.handleRequest(req, res).catch((error) => {
                this.respondJson(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        });
        await new Promise((resolvePromise, rejectPromise) => {
            server.once("error", rejectPromise);
            server.listen(this.options.port ?? 0, CURL_LOOPBACK_HOST, () => {
                server.removeListener("error", rejectPromise);
                resolvePromise();
            });
        });
        this.server = server;
        this.boundPort = server.address().port;
        await this.writeEndpointFile();
        this.emitState("connected");
    }
    async stop() {
        const server = this.server;
        this.server = null;
        if (server) {
            await new Promise((resolvePromise) => server.close(() => resolvePromise()));
        }
        await this.removeEndpointFile();
        this.boundPort = null;
        this.emitState("disconnected");
    }
    onInbound(handler) {
        this.inboundHandler = handler;
    }
    onFilterDrop(handler) {
        this.filterDropHandler = handler;
    }
    onConnectionState(handler) {
        this.stateHandler = handler;
        if (this.connectionState) {
            handler(this.connectionState);
        }
    }
    /**
     * V1 is inbound-only by spec: there is no caller to deliver outbound to —
     * the HTTP exchange is over by the time an agent replies. Loud diagnostic
     * instead of a silent no-op so a misrouted `bus.send` is debuggable.
     */
    async send(target, _payload, _idempotencyKey) {
        throw new Error(`agents-comm-bus curl[${this.accountId}]: outbound send to ` +
            `chat=${target.chat_native_id} is not supported — the curl adapter is ` +
            `local inbound-only (AGE-50 V1). Reply over a bidirectional comm ` +
            `(e.g. telegram/discord/matrix) instead.`);
    }
    reportPressure() {
        return { backlog: 0, rateLimited: false };
    }
    classifyFailure() {
        // Every failure this adapter raises (notably unsupported outbound) is
        // structural, not transient — retrying cannot succeed.
        return "permanent";
    }
    async handleRequest(req, res) {
        const pathname = new URL(req.url ?? "/", `http://${CURL_LOOPBACK_HOST}`).pathname;
        if (pathname !== CURL_MESSAGES_PATH) {
            this.respondJson(res, 404, { ok: false, error: `unknown path ${pathname}; POST ${CURL_MESSAGES_PATH}` });
            return;
        }
        if (req.method !== "POST") {
            this.respondJson(res, 405, { ok: false, error: `method ${req.method} not allowed; use POST` });
            return;
        }
        if (!isAuthorizedCurlRequest(req.headers.authorization, this.options.token)) {
            this.emitFilterDrop({
                reason: "unauthorized",
                update_kind: "http_post",
                chat_native_id: undefined,
            });
            this.respondJson(res, 401, {
                ok: false,
                error: "unauthorized: present the registration token as 'Authorization: Bearer <token>'",
            });
            return;
        }
        const rawBody = await this.readBody(req);
        if (rawBody === null) {
            this.respondJson(res, 413, { ok: false, error: `body exceeds ${this.maxBodyBytes} bytes` });
            return;
        }
        let decoded;
        try {
            decoded = JSON.parse(rawBody.toString("utf8"));
        }
        catch {
            this.respondJson(res, 400, { ok: false, error: "body is not valid JSON" });
            return;
        }
        const parsed = parseCurlPostBody(decoded);
        if ("error" in parsed) {
            this.respondJson(res, 400, { ok: false, error: parsed.error });
            return;
        }
        const body = parsed.body;
        if (normalizeProjectPath(body.project) !== this.normalizedProject ||
            body.agent !== this.options.agent) {
            this.respondJson(res, 404, {
                ok: false,
                error: `this curl endpoint serves project=${this.normalizedProject}, agent=${this.options.agent} ` +
                    `(got project=${body.project}, agent=${body.agent}); ` +
                    `register a curl account for that scope and POST to its endpoint`,
            });
            return;
        }
        if (this.allowedSenders.size > 0 && !this.allowedSenders.has(body.sender_id)) {
            this.emitFilterDrop({
                reason: "sender_not_allowed",
                update_kind: "http_post",
                sender_id: body.sender_id,
                chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id),
            });
            this.respondJson(res, 403, {
                ok: false,
                error: `sender_id ${body.sender_id} is not in this account's allowlist; fix with 'agents-comm allowlist add'`,
            });
            return;
        }
        this.traceFilterPass(body.sender_id);
        const handler = this.inboundHandler;
        if (!handler) {
            this.respondJson(res, 503, { ok: false, error: "adapter not attached to the bus yet; retry" });
            return;
        }
        const uuid = crypto.randomUUID();
        const chatNativeId = body.chat_native_id ?? syntheticChatNativeId(body.sender_id);
        const message = {
            schema_version: 1,
            message_id: `curl:${uuid}`,
            chat: {
                comm: this.id,
                account: this.accountId,
                chat_native_id: chatNativeId,
            },
            sender: {
                id: body.sender_id,
                isBot: false,
                isForeignBot: false,
            },
            origin: { comm: this.id },
            text: body.text,
            platform_message_id: uuid,
            hop_count: 0,
            received_at: this.now(),
        };
        if (body.metadata) {
            // Extra transcript-visible context for troubleshooting; the typed
            // Message contract has no metadata slot, so it rides as an extension
            // field that JSONL/transcript serialization preserves.
            message.metadata = body.metadata;
        }
        const acceptance = await handler(message);
        this.respondJson(res, 202, {
            ok: true,
            message_id: message.message_id,
            conversation_id: acceptance && typeof acceptance === "object" ? acceptance.conversation_id : undefined,
            chat_native_id: chatNativeId,
        });
    }
    readBody(req) {
        return new Promise((resolvePromise, rejectPromise) => {
            const chunks = [];
            let total = 0;
            req.on("data", (chunk) => {
                total += chunk.length;
                if (total > this.maxBodyBytes) {
                    req.removeAllListeners("data");
                    req.removeAllListeners("end");
                    resolvePromise(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => resolvePromise(Buffer.concat(chunks)));
            req.on("error", rejectPromise);
        });
    }
    respondJson(res, status, payload) {
        if (res.headersSent)
            return;
        const body = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(`${body}\n`);
    }
    async writeEndpointFile() {
        if (!this.options.stateRoot || this.boundPort === null)
            return;
        const filePath = curlEndpointFilePath(this.options.stateRoot, String(this.accountId));
        try {
            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, `${JSON.stringify({
                schema_version: 1,
                comm: this.id,
                account_id: this.accountId,
                project: this.normalizedProject,
                agent: this.options.agent,
                host: CURL_LOOPBACK_HOST,
                port: this.boundPort,
                url: `http://${CURL_LOOPBACK_HOST}:${this.boundPort}${CURL_MESSAGES_PATH}`,
                pid: process.pid,
                started_at: this.now(),
            }, null, 2)}\n`, "utf8");
        }
        catch (error) {
            // Discovery is a convenience; the adapter itself is healthy without it.
            this.log(`agents-comm-bus curl[${this.accountId}]: failed to write endpoint file ${filePath}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async removeEndpointFile() {
        if (!this.options.stateRoot)
            return;
        const filePath = curlEndpointFilePath(this.options.stateRoot, String(this.accountId));
        try {
            await rm(filePath, { force: true });
        }
        catch {
            // Best effort; a stale endpoint file is detectable by connection failure.
        }
    }
    emitState(state) {
        if (this.connectionState === state)
            return;
        this.connectionState = state;
        this.stateHandler?.(state);
    }
    emitFilterDrop(event) {
        try {
            this.filterDropHandler?.(event);
        }
        catch {
            // Observability must never break inbound handling.
        }
        if (this.filterTrace) {
            this.log(`agents-comm-bus curl[${this.accountId}] FILTER DROP: ${event.update_kind} ` +
                `sender=${event.sender_id ?? "<none>"} reason=${event.reason} ` +
                `(allowlist size=${this.allowedSenders.size})`);
        }
    }
    traceFilterPass(senderId) {
        if (!this.filterTrace)
            return;
        this.log(`agents-comm-bus curl[${this.accountId}] filter pass: http_post ` +
            `sender=${senderId} (allowlist size=${this.allowedSenders.size})`);
    }
}
//# sourceMappingURL=adapter.js.map
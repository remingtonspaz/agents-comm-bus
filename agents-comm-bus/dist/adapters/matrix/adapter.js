const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_RETRY_DELAY_MS = 1_000;
export function createFetchMatrixSyncClient(homeserverUrl, accessToken, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_SYNC_RETRY_DELAY_MS;
    const fetchFn = options.fetchFn ?? fetch;
    const baseUrl = homeserverUrl.replace(/\/+$/, "");
    let stopped = false;
    let loopPromise = null;
    let abortController = null;
    let retryTimer = null;
    let retryResolve = null;
    let nextBatch;
    const sleep = (ms) => new Promise((resolve) => {
        retryResolve = resolve;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            retryResolve = null;
            resolve();
        }, ms);
    });
    const cancelRetrySleep = () => {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        const resolve = retryResolve;
        retryResolve = null;
        resolve?.();
    };
    const fetchSync = async () => {
        abortController?.abort();
        abortController = new AbortController();
        const signal = abortController.signal;
        const timeout = setTimeout(() => abortController?.abort(), timeoutMs + 5_000);
        try {
            const url = new URL(`${baseUrl}/_matrix/client/v3/sync`);
            url.searchParams.set("timeout", String(timeoutMs));
            if (nextBatch) {
                url.searchParams.set("since", nextBatch);
            }
            const response = await fetchFn(url, {
                method: "GET",
                headers: { Authorization: `Bearer ${accessToken}` },
                signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                const error = new Error(`Matrix sync failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
                Object.assign(error, { status: response.status });
                throw error;
            }
            return await response.json();
        }
        finally {
            clearTimeout(timeout);
        }
    };
    const runLoop = async (handlers) => {
        while (!stopped) {
            try {
                const response = await fetchSync();
                if (stopped)
                    break;
                if (response.next_batch) {
                    nextBatch = response.next_batch;
                }
                await handlers.onSyncResponse(response);
            }
            catch (error) {
                if (stopped)
                    break;
                handlers.onError(error);
                await sleep(retryDelayMs);
            }
        }
    };
    return {
        async start(handlers) {
            if (loopPromise)
                return;
            stopped = false;
            loopPromise = runLoop(handlers);
        },
        async stop() {
            stopped = true;
            abortController?.abort();
            cancelRetrySleep();
            if (loopPromise) {
                await loopPromise.catch(() => { });
                loopPromise = null;
            }
            abortController = null;
        },
    };
}
export class MatrixCommAdapter {
    options;
    id = "matrix";
    accountId;
    homeserverUrl;
    accessToken;
    userId;
    syncClient;
    now;
    allowedUserIds;
    allowedRoomIds;
    inboundHandler = null;
    stateHandler = null;
    filterDropHandler = null;
    connectionState = null;
    started = false;
    constructor(options) {
        this.options = options;
        this.accountId = options.accountId;
        this.homeserverUrl = options.homeserverUrl;
        this.accessToken = options.accessToken;
        this.userId = options.userId;
        this.syncClient = options.syncClient ?? createFetchMatrixSyncClient(options.homeserverUrl, options.accessToken);
        this.now = options.now ?? Date.now;
        this.allowedUserIds = new Set(options.allowedUserIds ?? []);
        this.allowedRoomIds = new Set(options.allowedRoomIds ?? []);
    }
    get allowedSenderIds() {
        return Array.from(this.allowedUserIds);
    }
    updateAllowedSenderIds(ids) {
        this.allowedUserIds = new Set(ids);
    }
    exclusiveResource() {
        return { resourceId: String(this.accountId) };
    }
    async start() {
        if (this.started)
            return;
        this.emitState("connecting");
        try {
            await this.syncClient.start({
                onSyncResponse: async (response) => {
                    try {
                        await this.processSyncResponse(response);
                        this.emitState("connected");
                    }
                    catch {
                        this.emitState("degraded");
                    }
                },
                onError: () => {
                    this.emitState("degraded");
                },
            });
            this.started = true;
            this.emitState("connected");
        }
        catch {
            await this.syncClient.stop().catch(() => { });
            this.emitState("disconnected");
            throw new Error("Matrix sync client failed to start");
        }
    }
    async stop() {
        if (!this.started && this.connectionState === "disconnected")
            return;
        if (this.started) {
            await this.syncClient.stop().catch(() => { });
        }
        this.started = false;
        this.emitState("disconnected");
    }
    onInbound(handler) {
        this.inboundHandler = handler;
    }
    onConnectionState(handler) {
        this.stateHandler = handler;
        if (this.connectionState) {
            handler(this.connectionState);
        }
    }
    onFilterDrop(handler) {
        this.filterDropHandler = handler;
    }
    async send(_target, _payload, _idempotencyKey) {
        const error = new Error("Matrix outbound send is not implemented (P1 skeleton)");
        Object.assign(error, { status: 501 });
        throw error;
    }
    reportPressure() {
        return { backlog: 0, rateLimited: false };
    }
    classifyFailure(error) {
        const anyError = error;
        const message = anyError?.message ?? String(error);
        const status = anyError?.status
            ?? anyError?.statusCode
            ?? anyError?.response?.status
            ?? anyError?.response?.statusCode;
        const errcode = anyError?.errcode ?? anyError?.response?.body?.errcode;
        if (status === 401
            || status === 403
            || /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) {
            return "permanent";
        }
        if (status === 429
            || errcode === "M_LIMIT_EXCEEDED"
            || errcode === "M_USER_LIMIT_EXCEEDED"
            || /rate.?limit|too many requests|M_LIMIT_EXCEEDED|M_USER_LIMIT_EXCEEDED/i.test(message)) {
            return "rate_limited";
        }
        if (status === 501 || /not implemented/i.test(message)) {
            return "permanent";
        }
        if ((status != null && status >= 500) || /ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message)) {
            return "transient";
        }
        return "transient";
    }
    async processSyncResponse(response) {
        const joined = response.rooms?.join;
        if (!joined)
            return;
        for (const [roomId, roomData] of Object.entries(joined)) {
            const events = roomData.timeline?.events ?? [];
            for (const event of events) {
                await this.handleTimelineEvent(roomId, event);
            }
        }
    }
    async handleTimelineEvent(roomId, event) {
        if (!this.inboundHandler)
            return;
        if (event.type === "m.room.encrypted")
            return;
        if (event.type !== "m.room.message")
            return;
        const content = event.content;
        if (!content || typeof content !== "object")
            return;
        const msgtype = content.msgtype;
        if (msgtype !== "m.text" && msgtype !== "m.notice")
            return;
        const eventId = event.event_id;
        const sender = event.sender;
        const body = typeof content.body === "string" ? content.body : null;
        if (!eventId || !body)
            return;
        if (!sender) {
            this.emitFilterDrop({
                reason: "missing_sender_id",
                update_kind: "message",
                chat_native_id: roomId,
                platform_message_id: eventId,
            });
            return;
        }
        if (sender === this.accountId)
            return;
        if (this.allowedRoomIds.size > 0 && !this.allowedRoomIds.has(roomId)) {
            this.emitFilterDrop({
                reason: "sender_not_allowed",
                update_kind: "message",
                sender_id: sender,
                chat_native_id: roomId,
                platform_message_id: eventId,
            });
            return;
        }
        if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(sender)) {
            this.emitFilterDrop({
                reason: "sender_not_allowed",
                update_kind: "message",
                sender_id: sender,
                chat_native_id: roomId,
                platform_message_id: eventId,
            });
            return;
        }
        const replyTo = matrixReplyToMessageId(content);
        await this.inboundHandler({
            schema_version: 1,
            message_id: `matrix:${eventId}`,
            chat: {
                comm: this.id,
                account: this.accountId,
                chat_native_id: roomId,
            },
            sender: {
                id: sender,
                display_name: sender,
                isBot: false,
                isForeignBot: false,
            },
            origin: { comm: this.id },
            text: body,
            attachments: [],
            platform_message_id: eventId,
            reply_to: replyTo,
            hop_count: 0,
            received_at: typeof event.origin_server_ts === "number"
                ? event.origin_server_ts
                : this.now(),
        });
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
    }
}
function matrixReplyToMessageId(content) {
    const relatesTo = content["m.relates_to"];
    if (!relatesTo || typeof relatesTo !== "object")
        return undefined;
    const inReplyTo = relatesTo["m.in_reply_to"];
    if (!inReplyTo || typeof inReplyTo !== "object")
        return undefined;
    const eventId = inReplyTo.event_id;
    if (typeof eventId !== "string" || !eventId)
        return undefined;
    return `matrix:${eventId}`;
}
export function mxidLocalpart(userId) {
    const match = /^@([^:]+):/.exec(userId);
    return match ? match[1] : null;
}
export function isMatrixMxid(value) {
    return /^@[^:]+:[^:]+$/.test(value);
}
const defaultIdentityClient = {
    async whoami(homeserverUrl, accessToken) {
        const response = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            const error = new Error(`Matrix whoami failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
            Object.assign(error, { status: response.status });
            throw error;
        }
        return await response.json();
    },
};
export async function probeMatrixIdentity(homeserverUrl, accessToken, expectedUserId, client = defaultIdentityClient) {
    const whoami = await client.whoami(homeserverUrl, accessToken);
    if (whoami.is_guest) {
        throw new Error("Matrix guest accounts are not supported");
    }
    if (whoami.user_id !== expectedUserId) {
        throw new Error(`Matrix whoami user_id mismatch: expected ${expectedUserId}, got ${whoami.user_id}`);
    }
    return { user_id: whoami.user_id, localpart: mxidLocalpart(whoami.user_id) };
}
//# sourceMappingURL=adapter.js.map
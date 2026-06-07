export class MatrixCommAdapter {
    options;
    id = "matrix";
    accountId;
    homeserverUrl;
    accessToken;
    userId;
    allowedUserIds;
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
        this.allowedUserIds = new Set(options.allowedUserIds ?? []);
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
        this.started = true;
        this.emitState("connecting");
        this.emitState("connected");
    }
    async stop() {
        if (!this.started && this.connectionState === "disconnected")
            return;
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
    emitState(state) {
        if (this.connectionState === state)
            return;
        this.connectionState = state;
        this.stateHandler?.(state);
    }
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
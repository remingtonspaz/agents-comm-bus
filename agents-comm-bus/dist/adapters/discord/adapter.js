import { REST, RateLimitError } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { GatewayDispatchEvents } from "discord-api-types/v10";
import { DiscordGateway } from "./gateway.js";
import { buildMessageFromDiscordCreate } from "./normalize.js";
const EMPTY_ALLOWED_MENTIONS = { parse: [] };
const IDEMPOTENCY_CACHE_MAX = 256;
export class DiscordCommAdapter {
    options;
    id = "discord";
    accountId;
    now;
    sleep;
    filterTrace;
    log;
    allowedUserIds;
    sentByKey = new Map();
    inboundHandler = null;
    filterDropHandler = null;
    stateHandler = null;
    connectionState = null;
    rest = null;
    restForGateway = null;
    gateway = null;
    botUserId = null;
    rateLimited = false;
    constructor(options) {
        this.options = options;
        this.accountId = options.accountId;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.allowedUserIds = new Set(options.allowedUserIds ?? []);
        this.filterTrace = options.filterTrace ?? process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1";
        this.log = options.log ?? ((message) => console.error(message));
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
        this.emitState("connecting");
        if (!this.rest) {
            if (this.options.rest) {
                this.rest = this.options.rest;
            }
            else {
                this.restForGateway = new REST({ version: "10" }).setToken(this.options.botToken);
                this.rest = this.restForGateway;
            }
        }
        if (!this.restForGateway) {
            this.restForGateway = new REST({ version: "10" }).setToken(this.options.botToken);
        }
        const me = (await this.rest.get(Routes.user("@me")));
        this.botUserId = String(me.id);
        if (!this.gateway) {
            this.gateway = this.options.gateway ?? new DiscordGateway({
                token: this.options.botToken,
                rest: this.restForGateway,
            });
        }
        this.gateway.onConnectionState((state) => this.emitState(state));
        this.gateway.onDispatch((payload) => {
            if (payload.t !== GatewayDispatchEvents.MessageCreate)
                return;
            void this.handleDiscordMessageCreate(payload.d)
                .then(() => this.emitState("connected"))
                .catch(() => this.emitState("degraded"));
        });
        await this.gateway.connect();
    }
    async stop() {
        if (this.gateway) {
            await this.gateway.destroy();
            this.gateway = null;
        }
        this.rest?.destroy?.();
        this.rest = null;
        this.restForGateway = null;
        this.botUserId = null;
        this.rateLimited = false;
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
    async send(target, payload, idempotencyKey) {
        const cached = this.sentByKey.get(idempotencyKey);
        if (cached)
            return cached;
        const rest = this.requireRest();
        const body = discordMessageBody(payload);
        let retried429 = false;
        while (true) {
            try {
                const response = await rest.post(Routes.channelMessages(target.chat_native_id), { body });
                const platformMessageId = String(response.id);
                const result = {
                    platform_message_id: platformMessageId,
                    sent_at: this.now(),
                };
                this.rememberSent(idempotencyKey, result);
                this.rateLimited = false;
                this.emitState("connected");
                return result;
            }
            catch (error) {
                if (!retried429 && error instanceof RateLimitError) {
                    retried429 = true;
                    this.rateLimited = true;
                    await this.sleep(error.retryAfter * 1000);
                    continue;
                }
                throw error;
            }
        }
    }
    reportPressure() {
        return { backlog: 0, rateLimited: this.rateLimited };
    }
    classifyFailure(error) {
        if (error instanceof RateLimitError) {
            return "rate_limited";
        }
        const anyError = error;
        const message = anyError?.message ?? "";
        const status = anyError?.status ?? anyError?.rawError?.code;
        if (status === 401 || status === 403 || /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) {
            return "permanent";
        }
        if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
            return "rate_limited";
        }
        if ((typeof status === "number" && status >= 500) ||
            /ECONNRESET|ETIMEDOUT|ENOTFOUND|network|5\d{2}/i.test(message)) {
            return "transient";
        }
        return "transient";
    }
    async handleDiscordMessageCreate(raw) {
        if (!this.inboundHandler)
            return;
        const fromId = raw.author?.id == null ? null : String(raw.author.id);
        if (this.allowedUserIds.size > 0 && (!fromId || !this.allowedUserIds.has(fromId))) {
            this.emitFilterDrop({
                reason: fromId ? "sender_not_allowed" : "missing_sender_id",
                update_kind: "message",
                sender_id: fromId ?? undefined,
                chat_native_id: String(raw.channel_id),
                platform_message_id: String(raw.id),
            });
            return;
        }
        this.traceFilterPass("message", fromId);
        const botUserId = this.botUserId;
        if (!botUserId)
            throw new Error("Discord adapter has no bot identity");
        const threadParent = this.gateway?.threadParentChannelId(String(raw.channel_id));
        const message = buildMessageFromDiscordCreate(raw, {
            commId: this.id,
            botUserId,
            accountId: this.accountId,
            threadParentChannelId: threadParent,
            now: this.now,
        });
        if (!message)
            return;
        await this.inboundHandler(message);
    }
    rememberSent(idempotencyKey, result) {
        if (this.sentByKey.size >= IDEMPOTENCY_CACHE_MAX) {
            const oldest = this.sentByKey.keys().next().value;
            if (oldest !== undefined) {
                this.sentByKey.delete(oldest);
            }
        }
        this.sentByKey.set(idempotencyKey, result);
    }
    requireRest() {
        if (!this.rest)
            throw new Error("Discord adapter is not started");
        return this.rest;
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
            this.log(`agents-comm-bus discord[${this.accountId}] FILTER DROP: ${event.update_kind} ` +
                `sender=${event.sender_id ?? "<none>"} chat=${event.chat_native_id ?? "?"} ` +
                `msg=${event.platform_message_id ?? "?"} reason=${event.reason} ` +
                `(allowlist size=${this.allowedUserIds.size})`);
        }
    }
    traceFilterPass(updateKind, senderId) {
        if (!this.filterTrace)
            return;
        this.log(`agents-comm-bus discord[${this.accountId}] filter pass: ${updateKind} ` +
            `sender=${senderId ?? "<none>"} (allowlist size=${this.allowedUserIds.size})`);
    }
}
export function discordMessageBody(payload) {
    const body = {
        content: payload.text ?? "",
        allowed_mentions: EMPTY_ALLOWED_MENTIONS,
    };
    if (payload.reply_to != null) {
        body.message_reference = {
            message_id: String(payload.reply_to).replace(/^discord:/, ""),
        };
    }
    return body;
}
export async function probeDiscordIdentity(botToken, rest) {
    const client = rest ?? new REST({ version: "10" }).setToken(botToken);
    const me = (await client.get(Routes.user("@me")));
    return { bot_user_id: String(me.id), bot_username: me.username };
}
//# sourceMappingURL=adapter.js.map
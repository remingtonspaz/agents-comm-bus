import { REST, RateLimitError } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
const EMPTY_ALLOWED_MENTIONS = { parse: [] };
export class DiscordCommAdapter {
    options;
    id = "discord";
    accountId;
    now;
    sleep;
    sentByKey = new Map();
    inboundHandler = null;
    filterDropHandler = null;
    stateHandler = null;
    connectionState = null;
    rest = null;
    rateLimited = false;
    constructor(options) {
        this.options = options;
        this.accountId = options.accountId;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }
    exclusiveResource() {
        return { resourceId: String(this.accountId) };
    }
    async start() {
        this.emitState("connecting");
        if (!this.rest) {
            this.rest = this.options.rest ?? new REST({ version: "10" }).setToken(this.options.botToken);
        }
        await this.rest.get(Routes.user("@me"));
        this.emitState("connected");
    }
    async stop() {
        this.rest?.destroy?.();
        this.rest = null;
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
                this.sentByKey.set(idempotencyKey, result);
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
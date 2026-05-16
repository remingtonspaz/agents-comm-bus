import TelegramBot from "node-telegram-bot-api";
export class TelegramCommAdapter {
    options;
    id = "telegram";
    now;
    allowedUserIds;
    sentByKey = new Map();
    inboundHandler = null;
    callbackHandlers = [];
    stateHandler = null;
    connectionState = null;
    bot;
    botUserId = null;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.allowedUserIds = new Set(options.allowedUserIds ?? []);
        this.bot = options.bot ?? null;
    }
    async start() {
        this.emitState("connecting");
        if (!this.bot) {
            this.bot = new TelegramBot(this.options.botToken, {
                polling: this.options.polling ?? true,
            });
        }
        const me = await this.bot.getMe();
        this.botUserId = String(me.id);
        this.bot.on("message", (message) => {
            void this.handleTelegramMessage(message)
                .then(() => this.emitState("connected"))
                .catch(() => this.emitState("degraded"));
        });
        this.bot.on("callback_query", (query) => {
            void this.handleTelegramCallback(query)
                .then(() => this.emitState("connected"))
                .catch(() => this.emitState("degraded"));
        });
        this.bot.on("polling_error", () => this.emitState("degraded"));
        this.emitState("connected");
    }
    async stop() {
        if (this.bot?.isPolling()) {
            await this.bot.stopPolling();
        }
        this.emitState("disconnected");
    }
    onInbound(handler) {
        this.inboundHandler = handler;
    }
    onCallback(handler) {
        this.callbackHandlers.push(handler);
    }
    async answerCallback(callbackId, options = {}) {
        const bot = this.requireBot();
        await bot.answerCallbackQuery(callbackId, {
            text: options.text,
            show_alert: options.showAlert ?? false,
        });
    }
    async editMessage(chatNativeId, messageNativeId, text, options = {}) {
        const bot = this.requireBot();
        await bot.editMessageText(text, {
            chat_id: chatNativeId,
            message_id: Number(messageNativeId),
            parse_mode: options.format === "html" ? "HTML" : undefined,
        });
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
        const bot = this.requireBot();
        const options = telegramSendOptions(target, payload);
        let platformMessage;
        const firstAttachment = payload.attachments?.[0];
        if (firstAttachment?.local_path) {
            platformMessage = await bot.sendDocument(target.chat_native_id, firstAttachment.local_path, { ...options, caption: payload.text });
        }
        else {
            platformMessage = await bot.sendMessage(target.chat_native_id, payload.text ?? "", options);
        }
        const result = {
            platform_message_id: String(platformMessage.message_id),
            sent_at: this.now(),
        };
        this.sentByKey.set(idempotencyKey, result);
        this.emitState("connected");
        return result;
    }
    reportPressure() {
        return { backlog: 0, rateLimited: false };
    }
    classifyFailure(error) {
        const anyError = error;
        const message = anyError?.message ?? "";
        const status = anyError?.response?.statusCode ?? anyError?.response?.body?.error_code;
        if (status === 403 || /403|forbidden|blocked|kicked|deactivated/i.test(message)) {
            return "permanent";
        }
        if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
            return "rate_limited";
        }
        return "transient";
    }
    async handleTelegramCallback(raw) {
        if (this.callbackHandlers.length === 0)
            return;
        const fromId = String(raw.from.id);
        if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(fromId)) {
            return;
        }
        if (!raw.data || !raw.message)
            return;
        const event = {
            callback_id: raw.id,
            data: raw.data,
            from_id: fromId,
            chat_native_id: String(raw.message.chat.id),
            message_native_id: String(raw.message.message_id),
        };
        for (const handler of this.callbackHandlers) {
            await handler(event);
        }
    }
    async handleTelegramMessage(raw) {
        if (!this.inboundHandler)
            return;
        const fromId = raw.from?.id == null ? null : String(raw.from.id);
        if (this.allowedUserIds.size > 0 && (!fromId || !this.allowedUserIds.has(fromId))) {
            return;
        }
        const botUserId = this.botUserId;
        if (!botUserId)
            throw new Error("Telegram adapter has no bot identity");
        const text = raw.text ?? raw.caption;
        const attachments = normalizeAttachments(raw);
        if (!text && attachments.length === 0)
            return;
        await this.inboundHandler({
            schema_version: 1,
            message_id: `telegram:${raw.message_id}`,
            chat: {
                comm: this.id,
                account: botUserId,
                chat_native_id: String(raw.chat.id),
                thread_native_id: raw.message_thread_id == null ? undefined : String(raw.message_thread_id),
            },
            sender: {
                id: fromId ?? "unknown",
                display_name: raw.from?.username ?? raw.from?.first_name,
                isBot: raw.from?.is_bot ?? false,
                isForeignBot: raw.from?.is_bot === true && String(raw.from?.id) !== botUserId,
            },
            origin: { comm: this.id },
            text,
            attachments,
            platform_message_id: String(raw.message_id),
            reply_to: raw.reply_to_message?.message_id == null
                ? undefined
                : `telegram:${raw.reply_to_message.message_id}`,
            hop_count: 0,
            received_at: this.now(),
        });
    }
    requireBot() {
        if (!this.bot)
            throw new Error("Telegram adapter is not started");
        return this.bot;
    }
    emitState(state) {
        if (this.connectionState === state)
            return;
        this.connectionState = state;
        this.stateHandler?.(state);
    }
}
export async function probeTelegramIdentity(botToken) {
    const bot = new TelegramBot(botToken, { polling: false });
    const me = await bot.getMe();
    return { bot_user_id: String(me.id), bot_username: me.username };
}
function telegramSendOptions(target, payload) {
    const options = {};
    if (target.thread_native_id != null) {
        options.message_thread_id = Number(target.thread_native_id);
    }
    if (payload.format === "html") {
        options.parse_mode = "HTML";
    }
    if (payload.inline_keyboard && payload.inline_keyboard.length > 0) {
        options.reply_markup = {
            inline_keyboard: payload.inline_keyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callback_data }))),
        };
    }
    if (payload.reply_to != null) {
        options.reply_parameters = {
            message_id: Number(String(payload.reply_to).replace(/^telegram:/, "")),
        };
    }
    return options;
}
function normalizeAttachments(raw) {
    if (!raw.photo && !raw.document)
        return [];
    if (raw.document) {
        return [{
                mime: raw.document.mime_type ?? "application/octet-stream",
                filename: raw.document.file_name ?? String(raw.document.file_id),
                size: raw.document.file_size ?? 0,
                platform_metadata: { file_id: raw.document.file_id },
            }];
    }
    const photo = raw.photo?.[raw.photo.length - 1];
    if (!photo)
        return [];
    return [{
            mime: "image/jpeg",
            filename: `${photo.file_id}.jpg`,
            size: photo.file_size ?? 0,
            platform_metadata: { file_id: photo.file_id },
        }];
}
//# sourceMappingURL=adapter.js.map
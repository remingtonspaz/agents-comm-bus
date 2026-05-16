import TelegramBot from "node-telegram-bot-api";

import type {
  AccountId,
  Attachment,
  CallbackEvent,
  ChatRef,
  CommConnectionState,
  CommAdapter,
  FailureClassification,
  Message,
  MessageId,
  OutboundPayload,
  SendResult,
  CommId,
} from "../../../../../agents-comm-bus-core/dist/index.js";

export interface TelegramCommAdapterOptions {
  botToken: string;
  allowedUserIds?: readonly string[];
  polling?: boolean;
  bot?: TelegramBot;
  now?: () => number;
}

export class TelegramCommAdapter implements CommAdapter {
  readonly id = "telegram" as CommId;

  private readonly now: () => number;
  private readonly allowedUserIds: Set<string>;
  private readonly sentByKey = new Map<string, SendResult>();
  private inboundHandler: ((msg: Message) => Promise<void>) | null = null;
  private callbackHandler: ((event: CallbackEvent) => Promise<void>) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private bot: TelegramBot | null;
  private botUserId: string | null = null;

  constructor(private readonly options: TelegramCommAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.bot = options.bot ?? null;
  }

  async start(): Promise<void> {
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

  async stop(): Promise<void> {
    if (this.bot?.isPolling()) {
      await this.bot.stopPolling();
    }
    this.emitState("disconnected");
  }

  onInbound(handler: (msg: Message) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  onCallback(handler: (event: CallbackEvent) => Promise<void>): void {
    this.callbackHandler = handler;
  }

  async answerCallback(
    callbackId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ): Promise<void> {
    const bot = this.requireBot();
    await bot.answerCallbackQuery(callbackId, {
      text: options.text,
      show_alert: options.showAlert ?? false,
    });
  }

  async editMessage(
    chatNativeId: string,
    messageNativeId: string,
    text: string,
    options: { format?: "html" | "plain" } = {},
  ): Promise<void> {
    const bot = this.requireBot();
    await bot.editMessageText(text, {
      chat_id: chatNativeId,
      message_id: Number(messageNativeId),
      parse_mode: options.format === "html" ? "HTML" : undefined,
    });
  }

  onConnectionState(handler: (state: CommConnectionState) => void): void {
    this.stateHandler = handler;
    if (this.connectionState) {
      handler(this.connectionState);
    }
  }

  async send(
    target: ChatRef,
    payload: OutboundPayload,
    idempotencyKey: string,
  ): Promise<SendResult> {
    const cached = this.sentByKey.get(idempotencyKey);
    if (cached) return cached;
    const bot = this.requireBot();
    const options = telegramSendOptions(target, payload);
    let platformMessage;

    const firstAttachment = payload.attachments?.[0];
    if (firstAttachment?.local_path) {
      platformMessage = await bot.sendDocument(
        target.chat_native_id,
        firstAttachment.local_path,
        { ...options, caption: payload.text },
      );
    } else {
      platformMessage = await bot.sendMessage(
        target.chat_native_id,
        payload.text ?? "",
        options,
      );
    }

    const result = {
      platform_message_id: String(platformMessage.message_id),
      sent_at: this.now(),
    };
    this.sentByKey.set(idempotencyKey, result);
    this.emitState("connected");
    return result;
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: false };
  }

  classifyFailure(error: unknown): FailureClassification {
    const anyError = error as {
      message?: string;
      response?: { statusCode?: number; body?: { error_code?: number } };
      code?: string;
    };
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

  private async handleTelegramCallback(raw: TelegramBot.CallbackQuery): Promise<void> {
    if (!this.callbackHandler) return;
    const fromId = String(raw.from.id);
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(fromId)) {
      return;
    }
    if (!raw.data || !raw.message) return;
    await this.callbackHandler({
      callback_id: raw.id,
      data: raw.data,
      from_id: fromId,
      chat_native_id: String(raw.message.chat.id),
      message_native_id: String(raw.message.message_id),
    });
  }

  private async handleTelegramMessage(raw: TelegramBot.Message): Promise<void> {
    if (!this.inboundHandler) return;
    const fromId = raw.from?.id == null ? null : String(raw.from.id);
    if (this.allowedUserIds.size > 0 && (!fromId || !this.allowedUserIds.has(fromId))) {
      return;
    }
    const botUserId = this.botUserId;
    if (!botUserId) throw new Error("Telegram adapter has no bot identity");

    const text = raw.text ?? raw.caption;
    const attachments = normalizeAttachments(raw);
    if (!text && attachments.length === 0) return;

    await this.inboundHandler({
      schema_version: 1,
      message_id: `telegram:${raw.message_id}` as MessageId,
      chat: {
        comm: this.id,
        account: botUserId as AccountId,
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
        : (`telegram:${raw.reply_to_message.message_id}` as MessageId),
      hop_count: 0,
      received_at: this.now(),
    });
  }

  private requireBot(): TelegramBot {
    if (!this.bot) throw new Error("Telegram adapter is not started");
    return this.bot;
  }

  private emitState(state: CommConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandler?.(state);
  }
}

export async function probeTelegramIdentity(
  botToken: string,
): Promise<{ bot_user_id: string; bot_username?: string }> {
  const bot = new TelegramBot(botToken, { polling: false });
  const me = await bot.getMe();
  return { bot_user_id: String(me.id), bot_username: me.username };
}

function telegramSendOptions(target: ChatRef, payload: OutboundPayload): TelegramBot.SendMessageOptions {
  const options: TelegramBot.SendMessageOptions = {};
  if (target.thread_native_id != null) {
    options.message_thread_id = Number(target.thread_native_id);
  }
  if (payload.format === "html") {
    options.parse_mode = "HTML";
  }
  if (payload.inline_keyboard && payload.inline_keyboard.length > 0) {
    options.reply_markup = {
      inline_keyboard: payload.inline_keyboard.map((row) =>
        row.map((button) => ({ text: button.text, callback_data: button.callback_data })),
      ),
    };
  }
  if (payload.reply_to != null) {
    options.reply_parameters = {
      message_id: Number(String(payload.reply_to).replace(/^telegram:/, "")),
    };
  }
  return options;
}

function normalizeAttachments(raw: TelegramBot.Message): Attachment[] {
  if (!raw.photo && !raw.document) return [];
  if (raw.document) {
    return [{
      mime: raw.document.mime_type ?? "application/octet-stream",
      filename: raw.document.file_name ?? String(raw.document.file_id),
      size: raw.document.file_size ?? 0,
      platform_metadata: { file_id: raw.document.file_id },
    }];
  }
  const photo = raw.photo?.[raw.photo.length - 1];
  if (!photo) return [];
  return [{
    mime: "image/jpeg",
    filename: `${photo.file_id}.jpg`,
    size: photo.file_size ?? 0,
    platform_metadata: { file_id: photo.file_id },
  }];
}

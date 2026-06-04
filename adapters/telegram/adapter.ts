import TelegramBot from "node-telegram-bot-api";

import type {
  AccountId,
  Attachment,
  BlobStore,
  CallbackEvent,
  ChatRef,
  CommConnectionState,
  CommAdapter,
  FailureClassification,
  FilterDropEvent,
  Message,
  MessageId,
  OutboundPayload,
  SendResult,
  CommId,
} from "agents-comm-bus-core";

/**
 * If `error` is a Telegram getUpdates 409 Conflict (another live consumer is
 * polling the same bot token), return a LOUD, actionable message; else null.
 *
 * AGE-35: behind the cross-checkout comm-resource lease, a 409 means a
 * non-lease-aware poller (a stray daemon from an unmanaged process, or an
 * external bot instance) — it must be surfaced with the bot / account / resource,
 * not silently flapped to "degraded".
 */
export function pollingConflictMessage(
  error: unknown,
  accountId: string,
  botUserId: string | null,
): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b409\b/.test(message)) return null;
  return (
    `agents-comm-bus telegram: 409 Conflict polling getUpdates for bot ` +
    `${botUserId ?? accountId} (resourceId=${accountId}) — another process is ` +
    `consuming this bot's updates. Behind the comm-resource lease this should ` +
    `not happen; look for a stray daemon or an external poller. (${message})`
  );
}

export interface TelegramCommAdapterOptions {
  botToken: string;
  /**
   * Telegram `bot_user_id` this adapter is bound to. Used by `MessageBus`
   * to key its adapter map so multiple bots can share `comm.id="telegram"`.
   */
  accountId: AccountId;
  allowedUserIds?: readonly string[];
  polling?: boolean;
  bot?: TelegramBot;
  now?: () => number;
  attachmentBlobStore?: BlobStore;
  fetch?: typeof fetch;
  /**
   * Loud logger for actionable anomalies (e.g. a 409 polling conflict). Defaults
   * to console.error (→ the daemon's stderr). Injectable for tests.
   */
  log?: (message: string) => void;
  /**
   * AGE-10: verbose allowlist-filter tracing. When true, every inbound
   * allowlist evaluation (pass AND drop) logs one line via `log` — the
   * debug mode for "message sent but nothing happened at all" sessions.
   * Defaults to `process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1"`.
   */
  filterTrace?: boolean;
}

export class TelegramCommAdapter implements CommAdapter {
  readonly id = "telegram" as CommId;
  readonly accountId: AccountId;

  private readonly now: () => number;
  private allowedUserIds: Set<string>;
  private readonly sentByKey = new Map<string, SendResult>();
  private inboundHandler: ((msg: Message) => Promise<void>) | null = null;
  private readonly callbackHandlers: Array<(event: CallbackEvent) => Promise<void>> = [];
  private filterDropHandler: ((event: FilterDropEvent) => void) | null = null;
  private readonly filterTrace: boolean;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private bot: TelegramBot | null;
  private botUserId: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(private readonly options: TelegramCommAdapterOptions) {
    this.accountId = options.accountId;
    this.now = options.now ?? Date.now;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.bot = options.bot ?? null;
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? ((message) => console.error(message));
    this.filterTrace = options.filterTrace ?? process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1";
  }

  /**
   * Derived view of the allowlist. Returns a snapshot array each access so
   * callers (notably the bus's foreign-bot gate) always see the current Set
   * state. The backing Set is replaceable via {@link updateAllowedSenderIds}.
   */
  get allowedSenderIds(): readonly string[] {
    return Array.from(this.allowedUserIds);
  }

  /**
   * Replace the in-memory allowlist with a new set of ids. Called by the
   * daemon's reload path when DB-backed allowlist rows change for an
   * already-attached adapter — avoids tearing down + recreating the adapter
   * and its live polling connection.
   *
   * Concurrency note: the daemon (and Node's event loop) is single-threaded
   * today, so there's no torn-read concern — an inbound handler dispatch
   * that started before this assignment continues to read the OLD Set; the
   * next dispatch reads the NEW Set. If reload-during-receiveInbound ever
   * becomes truly concurrent (e.g. via worker threads), the contract
   * should become "atomic snapshot replace" rather than mid-flight mutation.
   */
  updateAllowedSenderIds(ids: readonly string[]): void {
    this.allowedUserIds = new Set(ids);
  }

  /**
   * Telegram's `getUpdates` long-poll allows exactly one live consumer per bot
   * token — a second poller gets `409 Conflict: terminated by other getUpdates`.
   * The exclusive resource is therefore the bot_user_id (this adapter's
   * accountId): the daemon takes a cross-checkout ownership lease keyed by
   * (id, resourceId) before starting this adapter, so a stray daemon from
   * another checkout never races us to a 409.
   */
  exclusiveResource(): { resourceId: string } | null {
    return { resourceId: String(this.accountId) };
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
    this.bot.on("polling_error", (error) => {
      this.emitState("degraded");
      // AGE-35: a 409 Conflict means another live consumer is polling this bot's
      // getUpdates. Behind the comm-resource lease that should not happen, so
      // surface it LOUDLY (stray daemon / external poller) instead of silently
      // degrading — for Telegram the 409 is the only platform signal of a
      // double-owner.
      const conflict = pollingConflictMessage(error, String(this.accountId), this.botUserId);
      if (conflict) this.log(conflict);
    });
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
    this.callbackHandlers.push(handler);
  }

  /**
   * AGE-10: subscribe to adapter-level inbound filter drops. Wired by the bus
   * in `registerComm`; one event per dropped update.
   */
  onFilterDrop(handler: (event: FilterDropEvent) => void): void {
    this.filterDropHandler = handler;
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
    if (this.callbackHandlers.length === 0) return;
    const fromId = String(raw.from.id);
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(fromId)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "callback",
        sender_id: fromId,
        chat_native_id: raw.message ? String(raw.message.chat.id) : undefined,
        platform_message_id: raw.message ? String(raw.message.message_id) : undefined,
      });
      return;
    }
    this.traceFilterPass("callback", fromId);
    if (!raw.data || !raw.message) return;
    const event: CallbackEvent = {
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

  private async handleTelegramMessage(raw: TelegramBot.Message): Promise<void> {
    if (!this.inboundHandler) return;
    const fromId = raw.from?.id == null ? null : String(raw.from.id);
    if (this.allowedUserIds.size > 0 && (!fromId || !this.allowedUserIds.has(fromId))) {
      this.emitFilterDrop({
        reason: fromId ? "sender_not_allowed" : "missing_sender_id",
        update_kind: "message",
        sender_id: fromId ?? undefined,
        chat_native_id: String(raw.chat.id),
        platform_message_id: String(raw.message_id),
      });
      return;
    }
    this.traceFilterPass("message", fromId);
    const botUserId = this.botUserId;
    if (!botUserId) throw new Error("Telegram adapter has no bot identity");

    const text = raw.text ?? raw.caption;
    const attachments = await this.normalizeAttachments(raw);
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

  private async normalizeAttachments(raw: TelegramBot.Message): Promise<Attachment[]> {
    const attachments = normalizeTelegramAttachments(raw);
    if (attachments.length === 0 || !this.options.attachmentBlobStore) {
      return attachments;
    }
    return Promise.all(attachments.map((attachment) => this.retrieveAttachment(attachment)));
  }

  private async retrieveAttachment(attachment: Attachment): Promise<Attachment> {
    const bot = this.requireBot();
    const fileId = attachmentFileId(attachment);
    if (!fileId) return attachment;
    try {
      const url = await bot.getFileLink(fileId);
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const content = new Uint8Array(await response.arrayBuffer());
      const ref = await this.options.attachmentBlobStore!.put(content, attachment.mime);
      return {
        ...attachment,
        size: attachment.size > 0 ? attachment.size : ref.size,
        blob_hash: ref.hash,
        local_path: this.options.attachmentBlobStore!.pathFor(ref),
        platform_metadata: {
          ...attachment.platform_metadata,
          file_id: fileId,
          retrieved_at: this.now(),
        },
      };
    } catch (error) {
      return {
        ...attachment,
        platform_metadata: {
          ...attachment.platform_metadata,
          file_id: fileId,
          retrieval_error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private emitState(state: CommConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandler?.(state);
  }

  /**
   * AGE-10: surface an adapter-level inbound drop instead of silently
   * returning. The handler (wired by the bus in `registerComm`) audits it as
   * `inbound_filter_drop`; with `filterTrace` enabled the drop also logs a
   * one-line trace via `log` for live debugging.
   */
  private emitFilterDrop(event: FilterDropEvent): void {
    try {
      this.filterDropHandler?.(event);
    } catch {
      // Observability must never break inbound handling.
    }
    if (this.filterTrace) {
      this.log(
        `agents-comm-bus telegram[${this.accountId}] FILTER DROP: ${event.update_kind} ` +
          `sender=${event.sender_id ?? "<none>"} chat=${event.chat_native_id ?? "?"} ` +
          `msg=${event.platform_message_id ?? "?"} reason=${event.reason} ` +
          `(allowlist size=${this.allowedUserIds.size})`,
      );
    }
  }

  /** AGE-10: with `filterTrace` enabled, log allowlist passes too — proof the filter is letting traffic through. */
  private traceFilterPass(updateKind: string, senderId: string | null): void {
    if (!this.filterTrace) return;
    this.log(
      `agents-comm-bus telegram[${this.accountId}] filter pass: ${updateKind} ` +
        `sender=${senderId ?? "<none>"} (allowlist size=${this.allowedUserIds.size})`,
    );
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

function normalizeTelegramAttachments(raw: TelegramBot.Message): Attachment[] {
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

function attachmentFileId(attachment: Attachment): string | null {
  const fileId = attachment.platform_metadata?.file_id;
  return typeof fileId === "string" && fileId.length > 0 ? fileId : null;
}

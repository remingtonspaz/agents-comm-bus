import type { Message } from "../messages.js";
import type { AccountId, Attachment, ChatRef, CommId, MessageId } from "../types.js";

export type CommConnectionState =
  | "connecting"
  | "connected"
  | "degraded"
  | "disconnected";

export interface InlineKeyboardButton {
  text: string;
  /**
   * Adapter-defined callback payload. Telegram caps callback_data at 64
   * bytes; adapters that don't support callbacks must ignore this field
   * and render the button as decorative or omit it.
   */
  callback_data: string;
}

export interface OutboundPayload {
  text?: string;
  attachments?: Attachment[];
  reply_to?: MessageId;
  /**
   * Optional formatting hint for `text`. When set to `"html"`, comm adapters
   * that support rich text (e.g. Telegram) should render the text with HTML
   * markup. When omitted or `"plain"`, the text is sent verbatim. Adapters
   * that do not support the requested format must fall back to plain text.
   */
  format?: "html" | "plain";
  /**
   * Optional inline keyboard, rendered as 2D rows of buttons. Adapters that
   * do not support inline keyboards (e.g. SMS) must ignore this field and
   * send the text alone.
   */
  inline_keyboard?: InlineKeyboardButton[][];
}

export interface CallbackEvent {
  /** Comm-native callback id (used for acknowledgement). */
  callback_id: string;
  /** The `callback_data` from the clicked button. */
  data: string;
  /** Comm-native sender id of the clicking user. */
  from_id: string;
  /** Comm-native chat id where the keyboard was shown. */
  chat_native_id: string;
  /** Comm-native message id of the message that carried the keyboard. */
  message_native_id: string;
}

export interface SendResult {
  platform_message_id: string;
  sent_at: number;
}

/**
 * Classification used by the bus to decide retry policy and surface health.
 *
 * - `permanent`: do not retry (e.g. chat deleted, bot kicked).
 * - `transient`: retry with backoff.
 * - `rate_limited`: retry after the platform's stated cooldown.
 */
export type FailureClassification = "permanent" | "transient" | "rate_limited";

export interface CommAdapter {
  readonly id: CommId;
  /**
   * Comm-native account id this adapter is bound to (e.g. Telegram
   * `bot_user_id`). Multiple adapters can share `id` as long as their
   * `accountId` differs; the bus keys its adapter map by `(id, accountId)`
   * so one daemon can host one bot per agent without collision.
   */
  readonly accountId: AccountId;

  /**
   * Optional: sender ids the adapter has been configured to accept. Used by
   * the bus's foreign-bot gate as a "pass" list — a foreign bot whose id is
   * in this list bypasses the default-deny. Returning `undefined` (or
   * omitting the field) means the bus falls back to its global foreign-bot
   * policy. Adapters that don't have a per-instance allowlist concept can
   * leave this unset.
   *
   * Implementations that support runtime allowlist updates should back this
   * value with mutable state and expose `updateAllowedSenderIds` so the
   * daemon's reload path can refresh it without recreating the adapter.
   */
  readonly allowedSenderIds?: readonly string[];

  /**
   * Optional: replace the adapter's `allowedSenderIds` with a new set of
   * ids at runtime. Called by the daemon's reload path when DB-backed
   * allowlist rows change for an already-attached adapter. Implementations
   * must update the same backing state the `allowedSenderIds` getter reads
   * so the bus's foreign-bot gate immediately observes the new value.
   *
   * Adapters without an allowlist concept can leave this unset.
   */
  updateAllowedSenderIds?(ids: readonly string[]): void;

  /**
   * Optional: declare this adapter's exclusive single-consumer backend resource.
   * If the platform allows only one live consumer per credential (Telegram
   * getUpdates → 409 on a 2nd poller), return a stable resource id; the daemon
   * acquires a cross-checkout ownership lease keyed by (id, resourceId) and only
   * starts this adapter once it holds the lease. Adapters with no single-consumer
   * backend (webhook / stateless send) return null.
   */
  exclusiveResource?(): { resourceId: string } | null;

  /** Start polling/streaming inbound traffic. */
  start(): Promise<void>;
  /** Stop and release platform connections. */
  stop(): Promise<void>;

  /** Register the inbound-message handler. */
  onInbound(handler: (msg: Message) => Promise<void>): void;

  /**
   * Optional: register a callback-event handler for adapters that support
   * inline keyboards. Callbacks are not inbound messages — they're button
   * presses that resolve queries directly. Adapters without callback support
   * may omit this method.
   */
  onCallback?(handler: (event: CallbackEvent) => Promise<void>): void;

  /**
   * Optional: acknowledge a callback so the comm UI can stop its loading
   * spinner. Adapters without callback support may omit this method.
   */
  answerCallback?(callbackId: string, options?: { text?: string; showAlert?: boolean }): Promise<void>;

  /**
   * Optional: edit a previously-sent message in place. Used to reflect the
   * outcome of a button-resolved query (e.g. strikethrough + "answered").
   * Adapters that can't edit may omit this method.
   */
  editMessage?(
    chatNativeId: string,
    messageNativeId: string,
    text: string,
    options?: { format?: "html" | "plain" },
  ): Promise<void>;

  /** Subscribe to connection-state transitions for health reporting. */
  onConnectionState(handler: (state: CommConnectionState) => void): void;

  /**
   * Idempotent send: calling `send` with the same `idempotencyKey` must not
   * produce duplicate platform messages. Implementations may either dedupe
   * locally or rely on the underlying platform's idempotency primitive.
   */
  send(
    target: ChatRef,
    payload: OutboundPayload,
    idempotencyKey: string,
  ): Promise<SendResult>;

  /**
   * Report current outbound pressure so the bus can apply backpressure
   * upstream rather than queue unboundedly.
   */
  reportPressure(): { backlog: number; rateLimited: boolean };

  /** Translate a raw error into a retry-policy class. */
  classifyFailure(error: unknown): FailureClassification;
}

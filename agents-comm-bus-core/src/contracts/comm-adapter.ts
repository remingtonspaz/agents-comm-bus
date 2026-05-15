import type { Message } from "../messages.js";
import type { Attachment, ChatRef, CommId, MessageId } from "../types.js";

export type CommConnectionState =
  | "connecting"
  | "connected"
  | "degraded"
  | "disconnected";

export interface OutboundPayload {
  text?: string;
  attachments?: Attachment[];
  reply_to?: MessageId;
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

  /** Start polling/streaming inbound traffic. */
  start(): Promise<void>;
  /** Stop and release platform connections. */
  stop(): Promise<void>;

  /** Register the inbound-message handler. */
  onInbound(handler: (msg: Message) => Promise<void>): void;

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

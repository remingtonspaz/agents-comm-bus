/**
 * Format daemon-delivered inbound messages for Pi prompt injection.
 *
 * Phase 4: port `formatInboundMessages` from
 * `hosts/claude/hooks/user-prompt-submit.js` — produce the familiar
 * `[Daemon Inbound Messages] ... [End Daemon Inbound Messages]` block.
 *
 * Envelope fields per message header: `comm`, `account` (concrete bot_user_id),
 * `account_label`, `chat_native_id`, `thread_native_id`, `conversation_id`,
 * `platform_message_id`, `message_id`. Attachment lines include mime, filename,
 * size, and `local_path` / `blob_hash` when available. No Pi-specific fields.
 */

/**
 * Mirrors `core-daemon/runtime/pending-inbound.PendingInboundEntry`
 * (not exported from agents-comm-bus package exports map).
 */
export interface PendingInboundEntry {
  message: {
    text?: string;
    received_at?: number;
    message_id?: string;
    platform_message_id?: string;
    sender?: { id?: string; display_name?: string };
    attachments?: Array<{
      mime?: string;
      filename?: string;
      size?: number;
      local_path?: string;
      blob_hash?: string;
      platform_metadata?: Record<string, unknown>;
    }>;
    chat?: {
      comm?: string;
      account?: string;
      chat_native_id?: string | number;
      thread_native_id?: string | number;
    };
  };
  conversation: {
    comm?: string;
    account_label?: string;
    conversation_id?: string;
    chat_native_id?: string | number;
    thread_native_id?: string | number;
  };
}

export function formatInboundMessages(_items: PendingInboundEntry[]): string {
  throw new Error("phase4: not implemented");
}

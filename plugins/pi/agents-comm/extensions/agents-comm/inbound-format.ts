/**
 * Format daemon-delivered inbound messages for Pi prompt injection.
 *
 * Ports `formatInboundMessages` from `hosts/claude/hooks/user-prompt-submit.js`.
 * Produces the `[Daemon Inbound Messages] ... [End Daemon Inbound Messages]` block
 * with envelope parity across Claude/Codex/Pi hosts.
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

function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAttachmentLine(attachment: NonNullable<PendingInboundEntry["message"]["attachments"]>[number]): string {
  const parts: string[] = [];
  const mime = attachment.mime && attachment.mime !== "application/octet-stream" ? attachment.mime : null;
  if (mime) parts.push(mime);
  if (attachment.filename) parts.push(attachment.filename);
  const size = formatBytes(attachment.size);
  if (size) parts.push(size);
  const header = parts.length > 0 ? parts.join(" · ") : "attachment";

  const meta = attachment.platform_metadata || {};
  if (meta.retrieval_error) {
    return `  📎 ${header} — retrieval failed: ${String(meta.retrieval_error)}`;
  }
  if (attachment.local_path) {
    return `  📎 ${header} → ${attachment.local_path} (use the Read tool to view)`;
  }
  if (attachment.blob_hash) {
    return `  📎 ${header} → blob ${attachment.blob_hash}`;
  }
  if (meta.file_id) {
    return `  📎 ${header} → telegram file_id ${String(meta.file_id)} (not downloaded)`;
  }
  return `  📎 ${header} (no local copy)`;
}

function messageText(message: PendingInboundEntry["message"]): string {
  const text = message?.text ? String(message.text).trim() : "";
  return text || "(no text)";
}

function formatTimestamp(value: number | undefined): string {
  const date = new Date(typeof value === "number" ? value : Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeInboundItem(item: PendingInboundEntry) {
  const message = item?.message || ({} as PendingInboundEntry["message"]);
  const conversation = item?.conversation || {};
  const chat = message?.chat || {};
  return { message, conversation, chat };
}

export function formatInboundMessages(items: PendingInboundEntry[]): string {
  const blocks = items.map((item) => {
    const { message, conversation, chat } = normalizeInboundItem(item);
    const sender = message?.sender || {};
    const senderName = sender.display_name || sender.id || "unknown sender";
    const envelope: Record<string, string | number | undefined> = {
      comm: chat.comm || conversation.comm,
      // `account` is the concrete bot_user_id — the routing key to echo back on
      // sends (AGE-15). Do NOT fall back to account_label here.
      account: chat.account,
      account_label: conversation.account_label,
      chat_native_id: chat.chat_native_id || conversation.chat_native_id,
      thread_native_id: chat.thread_native_id || conversation.thread_native_id || undefined,
      conversation_id: conversation.conversation_id,
      platform_message_id: message?.platform_message_id,
      message_id: message?.message_id,
    };
    const envelopeText = Object.entries(envelope)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const header = `[${formatTimestamp(message?.received_at)}] ${senderName} (${envelopeText}): ${messageText(message)}`;
    const attachmentLines = (message?.attachments || []).map(formatAttachmentLine);
    return [header, ...attachmentLines].join("\n");
  });

  return `[Daemon Inbound Messages]\n${blocks.join("\n")}\n[End Daemon Inbound Messages]`;
}

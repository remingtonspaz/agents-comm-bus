import type { ChatRef, MessageId, PermissionRequest, Sender } from "./types.js";

export interface ReplyEvent {
  sender: Sender;
  chat: ChatRef;
  reply_to_message_id?: MessageId;
  received_at: number;
}

export interface ValidateOptions {
  authorizedSenderIds: string[];
  alreadyResolved?: boolean;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: ValidationRejection };

export type ValidationRejection =
  | "expired"
  | "unauthorized_sender"
  | "wrong_chat"
  | "stale_link"
  | "already_resolved";

function chatRefMatches(a: ChatRef, b: ChatRef): boolean {
  if (a.comm !== b.comm) return false;
  if (a.account !== b.account) return false;
  if (a.id !== b.id) return false;
  // thread_id: if both defined they must match; both undefined OK; mixed -> mismatch
  if (a.thread_id === undefined && b.thread_id === undefined) return true;
  if (a.thread_id === undefined || b.thread_id === undefined) return false;
  return a.thread_id === b.thread_id;
}

export function validateReply(
  request: PermissionRequest,
  reply: ReplyEvent,
  options: ValidateOptions,
): ValidationResult {
  // 1. Already resolved
  if (options.alreadyResolved) {
    return { ok: false, reason: "already_resolved" };
  }

  // 2. TTL expiry
  if (reply.received_at - request.created_at > request.ttl_ms) {
    return { ok: false, reason: "expired" };
  }

  // 3. Authorized sender
  if (!options.authorizedSenderIds.includes(reply.sender.id)) {
    return { ok: false, reason: "unauthorized_sender" };
  }

  // 4. Stale link: reply targets a different message than the source
  if (
    reply.reply_to_message_id !== undefined &&
    request.source_message_id !== undefined &&
    reply.reply_to_message_id !== request.source_message_id
  ) {
    return { ok: false, reason: "stale_link" };
  }

  // 5. Link match accepts regardless of chat (both defined and equal)
  if (
    request.source_message_id !== undefined &&
    reply.reply_to_message_id === request.source_message_id
  ) {
    return { ok: true };
  }

  // 6. Same-chat fallback
  if (request.source_chat && chatRefMatches(request.source_chat, reply.chat)) {
    return { ok: true };
  }

  // 7. Otherwise wrong chat
  return { ok: false, reason: "wrong_chat" };
}

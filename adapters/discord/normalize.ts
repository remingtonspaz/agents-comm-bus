import type { APIMessage, APIAttachment, APIUser } from "discord-api-types/v10";

import type {
  AccountId,
  Attachment,
  CommId,
  Message,
  MessageId,
} from "agents-comm-bus-core";

export function normalizeDiscordAttachments(raw: APIMessage): Attachment[] {
  if (!raw.attachments?.length) return [];
  return raw.attachments.map((attachment: APIAttachment) => ({
    mime: attachment.content_type ?? "application/octet-stream",
    filename: attachment.filename,
    size: attachment.size ?? 0,
    platform_metadata: {
      url: attachment.url,
      attachment_id: attachment.id,
    },
  }));
}

function mentionDisplayName(mention: Pick<APIUser, "id" | "username" | "global_name">): string {
  const globalName = mention.global_name?.trim();
  if (globalName) return globalName;
  const username = mention.username?.trim();
  if (username) return username;
  return String(mention.id);
}

/**
 * Replace Discord user mention tokens in message content with readable names.
 * Role/channel mentions and unknown user ids are left unchanged.
 */
export function decodeDiscordMentions(
  content: string,
  mentions: readonly APIUser[] = [],
): string {
  const mentionById = new Map(
    mentions.map((mention) => [String(mention.id), mentionDisplayName(mention)]),
  );

  return content.replace(/<@!?(\d+)>/g, (match, id: string) => {
    const name = mentionById.get(id);
    if (name == null) return match;
    return `@${name} (<@${id}>)`;
  });
}

export interface DiscordInboundBuildContext {
  commId: CommId;
  botUserId: string;
  accountId: AccountId;
  threadParentChannelId?: string;
  now: () => number;
}

/**
 * Map a Discord MESSAGE_CREATE payload to a core bus Message (no adapter filtering).
 */
export function buildMessageFromDiscordCreate(
  raw: APIMessage,
  context: DiscordInboundBuildContext,
  attachmentsOverride?: Attachment[],
): Message | null {
  const fromId = raw.author?.id == null ? null : String(raw.author.id);
  const rawText = raw.content ?? undefined;
  const text = rawText == null ? undefined : decodeDiscordMentions(rawText, raw.mentions ?? []);
  const attachments = attachmentsOverride ?? normalizeDiscordAttachments(raw);
  if (!text && attachments.length === 0) return null;

  const threadParent = context.threadParentChannelId;
  const chatNativeId = threadParent ?? String(raw.channel_id);
  const threadNativeId = threadParent == null ? undefined : String(raw.channel_id);

  return {
    schema_version: 1,
    message_id: `discord:${raw.id}` as MessageId,
    chat: {
      comm: context.commId,
      account: context.botUserId as AccountId,
      chat_native_id: chatNativeId,
      thread_native_id: threadNativeId,
    },
    sender: {
      id: fromId ?? "unknown",
      display_name: raw.author?.global_name ?? raw.author?.username,
      isBot: raw.author?.bot ?? false,
      isForeignBot: raw.author?.bot === true && String(raw.author.id) !== context.botUserId,
    },
    origin: { comm: context.commId },
    text,
    attachments,
    platform_message_id: String(raw.id),
    reply_to: raw.message_reference?.message_id == null
      ? undefined
      : (`discord:${raw.message_reference.message_id}` as MessageId),
    hop_count: 0,
    received_at: context.now(),
  };
}

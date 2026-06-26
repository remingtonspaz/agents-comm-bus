import type { APIMessage, APIUser } from "discord-api-types/v10";
import type { AccountId, Attachment, CommId, Message } from "agents-comm-bus-core";
export declare function normalizeDiscordAttachments(raw: APIMessage): Attachment[];
/**
 * Replace Discord user mention tokens in message content with readable names.
 * Role/channel mentions and unknown user ids are left unchanged.
 */
export declare function decodeDiscordMentions(content: string, mentions?: readonly APIUser[]): string;
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
export declare function buildMessageFromDiscordCreate(raw: APIMessage, context: DiscordInboundBuildContext, attachmentsOverride?: Attachment[]): Message | null;
//# sourceMappingURL=normalize.d.ts.map
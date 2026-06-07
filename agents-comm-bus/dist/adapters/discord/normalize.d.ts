import type { APIMessage } from "discord-api-types/v10";
import type { AccountId, Attachment, CommId, Message } from "agents-comm-bus-core";
export declare function normalizeDiscordAttachments(raw: APIMessage): Attachment[];
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
export declare function buildMessageFromDiscordCreate(raw: APIMessage, context: DiscordInboundBuildContext): Message | null;
//# sourceMappingURL=normalize.d.ts.map
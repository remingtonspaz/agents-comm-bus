import type {
  Attachment,
  ChatRef,
  MessageId,
  Origin,
  Sender,
} from "./types.js";
import { SCHEMA_VERSION_MESSAGE } from "./types.js";

/**
 * Normalized inbound or outbound message envelope.
 *
 * `hop_count` is incremented on each bus-to-bus relay; used by the
 * loop-prevention layer (see `security.ts`).
 */
export interface Message {
  schema_version: typeof SCHEMA_VERSION_MESSAGE;
  message_id: MessageId;
  chat: ChatRef;
  sender: Sender;
  origin: Origin;
  text?: string;
  attachments?: Attachment[];
  reply_to?: MessageId;
  platform_message_id?: string;
  hop_count: number;
  received_at: number;
}

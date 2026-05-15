import type {
  Attachment,
  ChatRef,
  MessageId,
  Origin,
  Sender,
} from "./types.js";
import { SCHEMA_VERSION_MESSAGE } from "./types.js";

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

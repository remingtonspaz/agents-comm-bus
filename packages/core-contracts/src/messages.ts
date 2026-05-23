import type {
  Attachment,
  ChatRef,
  MessageId,
  Origin,
  Sender,
} from "./types.js";

export interface Message {
  schema_version: number;
  message_id: MessageId;
  chat: ChatRef;
  sender: Sender;
  origin: Origin;
  text?: string;
  attachments?: ReadonlyArray<Attachment>;
  reply_to?: MessageId;
  platform_message_id?: string;
  hop_count: number;
  received_at: number;
}

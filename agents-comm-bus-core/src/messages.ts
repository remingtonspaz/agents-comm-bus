import type {
  Attachment,
  ChatRef,
  MessageId,
  Origin,
  Sender,
} from "./types.js";
import { SCHEMA_VERSION_MESSAGE } from "./types.js";

/**
 * A message flowing through the bus. v4 non-negotiable: preserve platform
 * message IDs and reply references so adapters can round-trip back to the
 * originating platform (quote-replies, edits, threading, etc.).
 */
export interface Message {
  schema_version: typeof SCHEMA_VERSION_MESSAGE;
  message_id: MessageId;
  chat: ChatRef;
  sender: Sender;
  origin: Origin;
  text?: string;
  attachments?: Attachment[];
  /** Internal MessageId being replied to, if any. */
  reply_to?: MessageId;
  /** Native platform message id (preserved for round-tripping). */
  platform_message_id?: string;
  hop_count: number;
  received_at: number;
}

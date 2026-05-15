// JSONL, one file per conversation, append-only. v4 non-negotiable #7.
// Transcripts are the durable canonical record of every inbound/outbound
// Message; SQLite rows reference these but never duplicate the payload.

import type { ConversationId, MessageId } from "../types.js";

export interface TranscriptEntry {
  conversation_id: ConversationId;
  timestamp: number;
  direction: "inbound" | "outbound";
  message_id: MessageId;
  /** Serializable snapshot of the Message at the time of recording. */
  payload: unknown;
}

export interface TranscriptStore {
  append(entry: TranscriptEntry): Promise<void>;
  read(
    conversation_id: ConversationId,
    opts?: { since?: number; limit?: number },
  ): AsyncIterable<TranscriptEntry>;
}

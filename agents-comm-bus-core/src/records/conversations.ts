/**
 * `Conversation` is INVENTORY, not routing state.
 *
 * It records which chats/threads we have observed under a given account,
 * along with last-activity timestamps for lifecycle/cleanup purposes. It is
 * NOT consulted for message routing decisions — routing flows from
 * `Message.chat` + the agent/session resolution layer (v4 non-negotiable #4).
 */

import type {
  AgentId,
  CommId,
  ConversationId,
  MessageId,
} from "../types.js";
import { SCHEMA_VERSION_CONVERSATION } from "../types.js";

export interface Conversation {
  schema_version: typeof SCHEMA_VERSION_CONVERSATION;

  // Primary key. `thread_native_id` uses literal `null` (not undefined)
  // because it participates in the SQL PK; SQL treats NULL specially in
  // uniqueness, but we keep the JS shape explicit.
  project: string;
  comm: CommId;
  account_label: string;
  chat_native_id: string;
  thread_native_id: string | null;

  // Surrogate id for foreign-key references.
  conversation_id: ConversationId;

  // Which agent the chat belongs to.
  agent: AgentId;

  last_inbound_at: number | null;
  last_outbound_at: number | null;
  last_message_id: MessageId | null;
  created_at: number;
  metadata?: Record<string, unknown>;
}

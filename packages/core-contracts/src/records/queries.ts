import type {
  AgentId,
  ConversationId,
  MessageId,
  QueryId,
  SessionId,
} from "../types.js";
import { SCHEMA_VERSION_QUERY } from "../types.js";
import type { QueryKind, ResolvedDecision } from "../queries.js";

export type { QueryKind } from "../queries.js";

/**
 * Durable persistence shape for a `Query`.
 *
 * `options_json` stores the option list as JSON1 text in SQLite (only
 * meaningful for `kind === "choice"`); the in-memory `Query` carries a
 * decoded `options: string[]` instead.
 *
 * Primary key: `query_id`.
 *
 * Origin/source fields link the query back to the inbound chat/message
 * that elicited it (nullable for agent-initiated queries with no inbound
 * trigger).
 *
 * `resolved_at` + `resolution` are non-null exactly when the query has
 * been resolved (resolved-once invariant).
 */
export interface QueryRecord {
  schema_version: typeof SCHEMA_VERSION_QUERY;

  query_id: QueryId;
  agent: AgentId;
  session: SessionId;
  kind: QueryKind;
  prompt_text: string;
  created_at: number;
  ttl_seconds: number;

  origin_chat_id: ConversationId | null;
  source_message_id: MessageId | null;

  resolved_at: number | null;
  resolution: ResolvedDecision | null;

  // JSON1 text. Only meaningful when kind === "choice".
  options_json: string | null;
}

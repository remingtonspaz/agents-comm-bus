import type {
  AgentId,
  ChatRef,
  MessageId,
  QueryId,
  SessionId,
} from "./types.js";
import { SCHEMA_VERSION_QUERY } from "./types.js";

/**
 * The three kinds of agent-initiated queries the bus understands.
 *
 * - `approval`: yes/no/always-allow gate (e.g. permission prompt).
 * - `choice`: pick one of N options.
 * - `freetext`: open-ended response.
 */
export type QueryKind = "approval" | "choice" | "freetext";

/**
 * Unified query record. The same shape covers approvals, multiple-choice
 * prompts, and free-text questions — distinguished by `kind`.
 *
 * `resolution` is null until the query is resolved exactly once.
 */
export interface Query {
  schema_version: typeof SCHEMA_VERSION_QUERY;
  query_id: QueryId;
  agent: AgentId;
  session: SessionId;
  kind: QueryKind;
  origin_chat?: ChatRef;
  source_message_id?: MessageId;
  prompt_text: string;
  options?: string[];
  created_at: number;
  ttl_seconds: number;
  resolution?: ResolvedDecision;
}

export interface ResolvedDecision {
  query_id: QueryId;
  decision:
    | "allow"
    | "deny"
    | "always_allow"
    | "select_option"
    | "text";
  selected_option_index?: number;
  text?: string;
  decided_by_sender_id: string;
  decided_in_chat: ChatRef;
  decided_at: number;
}

/**
 * Turn-control signal: explicitly NOT a query. Used to start, steer, or
 * interrupt an agent's turn.
 */
export interface TurnControl {
  agent: AgentId;
  session: SessionId;
  kind: "start" | "steer" | "interrupt";
  payload?: unknown;
}

/**
 * Slash-command request from a user via a comm. Explicitly NOT a query.
 */
export interface SlashCommand {
  agent: AgentId;
  session: SessionId;
  command: string;
  args?: string[];
  requested_in_chat: ChatRef;
  requested_at: number;
}

import type {
  AgentId,
  ChatRef,
  MessageId,
  QueryId,
  SessionId,
} from "./types.js";
import { SCHEMA_VERSION_QUERY } from "./types.js";

export type QueryKind = "approval" | "choice" | "freetext";

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
  decision: "allow" | "deny" | "always_allow" | "select_option" | "text";
  selected_option_index?: number;
  text?: string;
  decided_by_sender_id: string;
  decided_in_chat: ChatRef;
  decided_at: number;
}

// Explicitly NOT a query — turn control is out-of-band steering.
export interface TurnControl {
  agent: AgentId;
  session: SessionId;
  kind: "start" | "steer" | "interrupt";
  payload?: unknown;
}

// Explicitly NOT a query — slash commands are direct execution requests.
export interface SlashCommand {
  agent: AgentId;
  session: SessionId;
  command: string;
  args?: string[];
  requested_in_chat: ChatRef;
  requested_at: number;
}

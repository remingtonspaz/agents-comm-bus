import type {
  AgentId,
  ChatRef,
  MessageId,
  QueryId,
  SessionId,
} from "./types.js";
import { SCHEMA_VERSION_QUERY } from "./types.js";

export type QueryKind = "approval" | "choice" | "freetext";

export interface QueryOption {
  index: number;
  label: string;
  description?: string;
}

export interface Query {
  schema_version: typeof SCHEMA_VERSION_QUERY;
  query_id: QueryId;
  agent: AgentId;
  session: SessionId;
  kind: QueryKind;
  origin_chat?: ChatRef;
  source_message_id?: MessageId;
  prompt_text: string;
  options?: QueryOption[];
  created_at: number;
  ttl_seconds: number;
  resolution?: ResolvedDecision;
}

export type QueryDecision =
  | "allow"
  | "deny"
  | "always_allow"
  | "select_option"
  | "text";

export interface ResolvedDecision {
  query_id: QueryId;
  decision: QueryDecision;
  selected_option_index?: number;
  text?: string;
  decided_by_sender_id: string;
  decided_in_chat: ChatRef;
  decided_at: number;
}

export interface TurnControl {
  agent: AgentId;
  session: SessionId;
  kind: "start" | "steer" | "interrupt";
  payload?: unknown;
}

export interface SlashCommand {
  agent: AgentId;
  session: SessionId;
  command: string;
  args?: string[];
  requested_in_chat: ChatRef;
  requested_at: number;
}

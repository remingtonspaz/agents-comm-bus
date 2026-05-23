import type {
  AgentId,
  ChatRef,
  MessageId,
  QueryId,
  SessionId,
} from "./types.js";

export type QueryKind = "approval" | "choice" | "freetext";

export interface Query {
  schema_version: number;
  query_id: QueryId;
  agent: AgentId;
  session: SessionId;
  kind: QueryKind;
  origin_chat?: ChatRef;
  source_message_id?: MessageId;
  prompt_text: string;
  options?: ReadonlyArray<string>;
  created_at: number;
  ttl_seconds: number;
  resolution?: ResolvedDecision;
}

export type Decision =
  | "allow"
  | "deny"
  | "always_allow"
  | "select_option"
  | "text";

export interface ResolvedDecision {
  query_id: QueryId;
  decision: Decision;
  selected_option_index?: number;
  text?: string;
  decided_by_sender_id: string;
  decided_in_chat: ChatRef;
  decided_at: number;
}

// TurnControl and SlashCommand are explicitly NOT queries — they are
// direct agent-control records, not awaiting-resolution prompts.

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
  args?: ReadonlyArray<string>;
  requested_in_chat: ChatRef;
  requested_at: number;
}

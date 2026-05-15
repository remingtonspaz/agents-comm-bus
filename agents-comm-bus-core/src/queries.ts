import type {
  AgentId,
  ChatRef,
  MessageId,
  QueryId,
  SessionId,
} from "./types.js";
import { SCHEMA_VERSION_QUERY } from "./types.js";

export type QueryKind = "approval" | "choice" | "freetext";

export type QueryDecisionKind =
  | "allow"
  | "deny"
  | "always_allow"
  | "select_option"
  | "text";

/**
 * A question raised by an agent that requires a human (or routed) decision.
 *
 * Queries are the ONLY domain for human-decision prompts (permission /
 * AskUserQuestion / plan-mode). Turn control and slash commands are
 * separate domains — see {@link TurnControl} and {@link SlashCommand}.
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
  options?: Array<{ label: string; description?: string }>;
  created_at: number;
  ttl_seconds: number;
  resolution?: ResolvedDecision;
}

export interface ResolvedDecision {
  query_id: QueryId;
  decision: QueryDecisionKind;
  selected_option_index?: number;
  text?: string;
  decided_by_sender_id: string;
  decided_in_chat: ChatRef;
  decided_at: number;
}

/**
 * Turn control signal for an agent session (start a new turn, steer the
 * current turn, or interrupt it).
 *
 * v4 non-negotiable #5: TurnControl is explicitly NOT a {@link Query}. It is
 * a separate domain — turn control does not have a "decision" lifecycle, has
 * no TTL, no options, and is not user-resolved.
 */
export interface TurnControl {
  agent: AgentId;
  session: SessionId;
  kind: "start" | "steer" | "interrupt";
  payload?: unknown;
}

/**
 * A slash command requested by a user, to be forwarded to the agent.
 *
 * v4 non-negotiable #5: SlashCommand is explicitly NOT a {@link Query}. It is
 * an imperative request from the user, not a question awaiting a decision.
 */
export interface SlashCommand {
  agent: AgentId;
  session: SessionId;
  command: string;
  args?: string[];
  requested_in_chat: ChatRef;
  requested_at: number;
}

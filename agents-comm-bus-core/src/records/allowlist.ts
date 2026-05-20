import type { CommId } from "../types.js";

/**
 * Allowlist entry that applies to every adapter of a comm.
 *
 * A foreign-bot or non-default sender whose `(comm, sender_id)` matches a
 * row here passes the bus's foreign-bot gate regardless of which receiving
 * bot saw the message. Use for human operators and bots that should be
 * trusted across every Telegram (or other comm) account the daemon hosts.
 */
export interface AllowlistGlobalEntry {
  comm: CommId;
  sender_id: string;
  added_at: number;
  added_by?: string;
  note?: string;
}

/**
 * Allowlist entry scoped to a specific receiving bot.
 *
 * Only inbounds arriving at `bot_user_id` on `comm` consult this entry.
 * Use for fine-grained "this sender can talk to Claude's bot but not
 * Codex's bot" cases.
 */
export interface AllowlistPerBotEntry {
  comm: CommId;
  bot_user_id: string;
  sender_id: string;
  added_at: number;
  added_by?: string;
  note?: string;
}

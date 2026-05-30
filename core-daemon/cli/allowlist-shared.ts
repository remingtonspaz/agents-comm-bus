import type {
  AccountRegistration,
  CommId,
  Storage,
} from "agents-comm-bus-core";
import { resolveAccountByLabel } from "./account-selector.js";

export interface PerBotSelector {
  comm: CommId;
  /** Canonical per-bot selector. Labels are display metadata only. */
  botId?: string;
  agent?: string;
  project?: string;
  accountLabel?: string;
}

/**
 * Resolve a per-bot selector to a `bot_user_id`.
 *
 * `--bot-id` is canonical. Explicit label targeting is UX sugar only and must
 * resolve to exactly one account; labels like "main" can collide across agents.
 */
export async function resolvePerBotSelector(
  storage: Storage,
  selector: PerBotSelector,
): Promise<{ bot_user_id: string; matched?: AccountRegistration }> {
  if (selector.botId) {
    return { bot_user_id: selector.botId };
  }
  if (!selector.accountLabel) {
    throw new Error(
      `per-bot allowlist scope requires --bot-id or --account-label for ${selector.comm}; ` +
        `run \`agents-comm account-list\` to find the bot_user_id.`,
    );
  }

  const matched = await resolveAccountByLabel(storage, {
    comm: selector.comm,
    accountLabel: selector.accountLabel,
    agent: selector.agent,
    project: selector.project,
  });
  return { bot_user_id: matched.bot_user_id, matched };
}

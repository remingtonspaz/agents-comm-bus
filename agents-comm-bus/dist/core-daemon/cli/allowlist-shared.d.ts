import type { CommId, Storage } from "agents-comm-bus-core";
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
 * Per-bot allowlist rows are keyed by `(comm, bot_user_id, sender_id)`, so
 * side-effecting CLI operations must identify the bot by `--bot-id`. Labels
 * like "main" are human metadata and can collide across agents.
 */
export declare function resolvePerBotSelector(_storage: Storage, selector: PerBotSelector): Promise<{
    bot_user_id: string;
}>;
//# sourceMappingURL=allowlist-shared.d.ts.map
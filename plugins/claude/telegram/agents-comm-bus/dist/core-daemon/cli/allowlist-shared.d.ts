import type { AccountRegistration, CommId, Storage } from "agents-comm-bus-core";
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
export declare function resolvePerBotSelector(storage: Storage, selector: PerBotSelector): Promise<{
    bot_user_id: string;
    matched?: AccountRegistration;
}>;
//# sourceMappingURL=allowlist-shared.d.ts.map
import type { AccountRegistration, CommId, Storage } from "agents-comm-bus-core";
export interface PerBotSelector {
    comm: CommId;
    /** Override: caller passed --bot-id directly. Skip resolution. */
    botId?: string;
    agent?: string;
    /** Project directory. Caller already applied cwd default if needed. */
    project?: string;
    accountLabel?: string;
}
/**
 * Resolve a per-bot selector to a `bot_user_id`. Resolution order:
 *
 *   1. If `botId` is set, use it directly.
 *   2. Otherwise look up `account_registrations` with the provided
 *      `(agent, comm, project)` filter and an `account_label` default of
 *      `"main"`. Require exactly one match.
 *
 * The caller is responsible for filling `project` from `process.cwd()` when
 * appropriate; this function does NOT silently fall back to cwd to keep
 * "did I run this from the right directory?" errors loud.
 */
export declare function resolvePerBotSelector(storage: Storage, selector: PerBotSelector): Promise<{
    bot_user_id: string;
    matched?: AccountRegistration;
}>;
//# sourceMappingURL=allowlist-shared.d.ts.map
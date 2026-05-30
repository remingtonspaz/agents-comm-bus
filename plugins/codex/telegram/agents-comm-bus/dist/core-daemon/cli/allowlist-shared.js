import { resolveAccountByLabel } from "./account-selector.js";
/**
 * Resolve a per-bot selector to a `bot_user_id`.
 *
 * `--bot-id` is canonical. Explicit label targeting is UX sugar only and must
 * resolve to exactly one account; labels like "main" can collide across agents.
 */
export async function resolvePerBotSelector(storage, selector) {
    if (selector.botId) {
        return { bot_user_id: selector.botId };
    }
    if (!selector.accountLabel) {
        throw new Error(`per-bot allowlist scope requires --bot-id or --account-label for ${selector.comm}; ` +
            `run \`agents-comm account-list\` to find the bot_user_id.`);
    }
    const matched = await resolveAccountByLabel(storage, {
        comm: selector.comm,
        accountLabel: selector.accountLabel,
        agent: selector.agent,
        project: selector.project,
    });
    return { bot_user_id: matched.bot_user_id, matched };
}
//# sourceMappingURL=allowlist-shared.js.map
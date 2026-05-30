/**
 * Resolve a per-bot selector to a `bot_user_id`.
 *
 * Per-bot allowlist rows are keyed by `(comm, bot_user_id, sender_id)`, so
 * side-effecting CLI operations must identify the bot by `--bot-id`. Labels
 * like "main" are human metadata and can collide across agents.
 */
export async function resolvePerBotSelector(_storage, selector) {
    if (selector.botId) {
        return { bot_user_id: selector.botId };
    }
    const deprecatedFields = [
        selector.agent ? "--agent" : null,
        selector.project ? "--project" : null,
        selector.accountLabel ? "--account-label" : null,
    ].filter(Boolean).join(", ");
    throw new Error(`per-bot allowlist scope requires --bot-id for ${selector.comm}. ` +
        `Labels and scoped selectors${deprecatedFields ? ` (${deprecatedFields})` : ""} ` +
        `are not bot identity and are no longer accepted; ` +
        `run \`agents-comm account-list\` to find the bot_user_id.`);
}
//# sourceMappingURL=allowlist-shared.js.map
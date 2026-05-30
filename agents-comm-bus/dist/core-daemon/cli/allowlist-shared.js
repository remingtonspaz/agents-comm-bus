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
    const candidates = await storage.listAccountRegistrations({
        project: selector.project,
        comm: selector.comm,
        agent: selector.agent,
    });
    const matches = candidates.filter((row) => row.account_label === selector.accountLabel);
    if (matches.length === 0) {
        throw new Error(`no account registration found for ` +
            `(comm=${selector.comm}, account-label=${selector.accountLabel}` +
            `${selector.agent ? `, agent=${selector.agent}` : ""}` +
            `${selector.project ? `, project=${selector.project}` : ""}); ` +
            `use --bot-id, or run \`agents-comm account-list\` to inspect registered accounts`);
    }
    if (matches.length > 1) {
        throw new Error(`account label "${selector.accountLabel}" is ambiguous for ${selector.comm}; ` +
            `matched bot ids: ${matches.map((m) => m.bot_user_id).join(", ")}. ` +
            `Narrow with --agent/--project or use --bot-id.`);
    }
    return { bot_user_id: matches[0].bot_user_id, matched: matches[0] };
}
//# sourceMappingURL=allowlist-shared.js.map
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
export async function resolvePerBotSelector(storage, selector) {
    if (selector.botId) {
        return { bot_user_id: selector.botId };
    }
    if (!selector.agent) {
        throw new Error("per-bot scope requires either --bot-id, or --agent (with --project or run from a project dir)");
    }
    if (!selector.project) {
        throw new Error("per-bot scope without --bot-id requires --project (or run the command from inside the project dir)");
    }
    const accountLabel = selector.accountLabel ?? "main";
    const candidates = await storage.listAccountRegistrations({
        project: selector.project,
        comm: selector.comm,
        agent: selector.agent,
    });
    const matches = candidates.filter((row) => row.account_label === accountLabel);
    if (matches.length === 0) {
        throw new Error(`no account registration found for ` +
            `(project=${selector.project}, comm=${selector.comm}, agent=${selector.agent}, account-label=${accountLabel}); ` +
            "use --bot-id to skip resolution, or run `agents-comm account-list` to inspect what's registered");
    }
    if (matches.length > 1) {
        throw new Error(`multiple account registrations match the selector — specify --bot-id directly. ` +
            `Matched: ${matches.map((m) => m.bot_user_id).join(", ")}`);
    }
    return { bot_user_id: matches[0].bot_user_id, matched: matches[0] };
}
//# sourceMappingURL=allowlist-shared.js.map
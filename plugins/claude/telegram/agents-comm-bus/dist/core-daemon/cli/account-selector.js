export async function resolveAccountByLabel(storage, selector) {
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
            "use --bot-id, or run `agents-comm account-list` to inspect registered accounts");
    }
    if (matches.length > 1) {
        throw new Error(`account label "${selector.accountLabel}" is ambiguous for ${selector.comm}; ` +
            `matched bot ids: ${matches.map((row) => row.bot_user_id).join(", ")}. ` +
            "Narrow with --agent/--project or use --bot-id.");
    }
    return matches[0];
}
//# sourceMappingURL=account-selector.js.map
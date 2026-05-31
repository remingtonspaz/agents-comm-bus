import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolveAccountByLabel } from "./account-selector.js";
export async function accountRelabel(options) {
    const comm = (options.comm ?? "telegram");
    if (!options.newAccountLabel) {
        throw new Error("--new-account-label is required for account-relabel");
    }
    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
    try {
        const current = await resolveCurrentAccount(storage, {
            comm,
            botId: options.botId,
            accountLabel: options.accountLabel,
            agent: options.agent,
            project: options.project,
        });
        return storage.updateAccountRegistrationLabel({
            comm,
            bot_user_id: current.bot_user_id,
            account_label: options.newAccountLabel,
            updated_at: Date.now(),
        });
    }
    finally {
        await storage.close();
    }
}
async function resolveCurrentAccount(storage, selector) {
    if (selector.botId) {
        const row = await storage.getAccountByBot(selector.comm, selector.botId);
        if (!row) {
            throw new Error(`no account registration found for (comm=${selector.comm}, bot-id=${selector.botId}); ` +
                "run `agents-comm account-list` to inspect registered accounts");
        }
        return row;
    }
    if (!selector.accountLabel) {
        throw new Error(`account-relabel requires --bot-id or --account-label for ${selector.comm}; ` +
            "run `agents-comm account-list` to inspect registered accounts");
    }
    return resolveAccountByLabel(storage, {
        comm: selector.comm,
        accountLabel: selector.accountLabel,
        agent: selector.agent,
        project: selector.project,
    });
}
//# sourceMappingURL=account-relabel.js.map
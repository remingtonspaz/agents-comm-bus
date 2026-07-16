import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { probeIdentityViaDaemon } from "./identity-probe.js";
import { redact } from "./redact.js";
export async function accountLookup(options) {
    const botToken = options.botToken;
    if (!botToken) {
        throw new Error("--bot-token is required");
    }
    const comm = (options.comm ?? "telegram");
    const identity = await (options.probeIdentity ?? ((creds, accountId) => probeIdentityViaDaemon({
        comm,
        credentials: creds,
        accountId,
        stateRoot: options.stateRoot,
    })))({ botToken }, options.accountId);
    const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
    try {
        const row = await storage.getAccountByBot(comm, identity.bot_user_id);
        return {
            registered: Boolean(row),
            bot_user_id: identity.bot_user_id,
            bot_username: identity.bot_username ?? null,
            registration: row ? redact(row) : null,
        };
    }
    finally {
        await storage.close();
    }
}
export function formatAccountLookup(result) {
    const lines = [
        "agents-comm-bus account-lookup",
        "",
        `registered: ${result.registered ? "yes" : "no"}`,
        `bot_user_id: ${result.bot_user_id}`,
        `bot_username: ${result.bot_username ?? "(none)"}`,
    ];
    if (result.registration) {
        lines.push(`project: ${result.registration.project}`, `agent: ${result.registration.agent}`, `comm: ${result.registration.comm}`, `account_label: ${result.registration.account_label}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=account-lookup.js.map
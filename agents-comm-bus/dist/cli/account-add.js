import { SCHEMA_VERSION_ACCOUNT, } from "../../../agents-comm-bus-core/dist/index.js";
import { probeTelegramIdentity } from "../adapters/comm/telegram.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
export async function accountAdd(options) {
    const comm = (options.comm ?? "telegram");
    if (comm !== "telegram") {
        throw new Error(`unsupported comm for phase 1 account-add: ${comm}`);
    }
    const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        throw new Error("TELEGRAM_BOT_TOKEN or --bot-token is required for telegram account-add");
    }
    const identity = await probeTelegramIdentity(botToken);
    const storage = await openSqliteStorage(resolveStatePaths().database);
    const now = Date.now();
    const registration = {
        schema_version: SCHEMA_VERSION_ACCOUNT,
        project: options.project,
        comm,
        agent: options.agent,
        account_label: options.accountLabel,
        bot_user_id: identity.bot_user_id,
        bot_username: identity.bot_username,
        credentials_ref: options.credentialsRef ?? "env:TELEGRAM_BOT_TOKEN",
        created_at: now,
        updated_at: now,
        metadata: { source: "account-add" },
    };
    await storage.putAccountRegistration(registration);
    await storage.close();
    return registration;
}
//# sourceMappingURL=account-add.js.map
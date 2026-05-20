import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolvePerBotSelector } from "./allowlist-shared.js";
export async function allowlistRemove(options) {
    const comm = options.comm;
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        if (options.scope === "global") {
            await storage.removeAllowlistGlobal(comm, options.user);
            return { scope: "global", comm, sender_id: options.user };
        }
        const selector = {
            comm,
            botId: options.botId,
            agent: options.agent,
            project: options.project,
            accountLabel: options.accountLabel,
        };
        const { bot_user_id } = await resolvePerBotSelector(storage, selector);
        await storage.removeAllowlistPerBot(comm, bot_user_id, options.user);
        return { scope: "per-bot", comm, bot_user_id, sender_id: options.user };
    }
    finally {
        await storage.close();
    }
}
//# sourceMappingURL=allowlist-remove.js.map
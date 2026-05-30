import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolvePerBotSelector } from "./allowlist-shared.js";
export async function allowlistList(options = {}) {
    const scope = options.scope ?? "all";
    const comm = options.comm;
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        const global = scope === "per-bot" ? [] : await storage.listAllowlistGlobal({ comm });
        if (scope === "global") {
            return { global, per_bot: [] };
        }
        let per_bot;
        const hasPerBotSelector = Boolean(options.botId || options.agent || options.project || options.accountLabel);
        if (hasPerBotSelector) {
            if (!comm) {
                throw new Error("--comm is required when selecting per-bot rows");
            }
            const selector = {
                comm,
                botId: options.botId,
                agent: options.agent,
                project: options.project,
                accountLabel: options.accountLabel,
            };
            const { bot_user_id } = await resolvePerBotSelector(storage, selector);
            per_bot = await storage.listAllowlistPerBot({ comm, bot_user_id });
        }
        else {
            per_bot = await storage.listAllowlistPerBot({ comm });
        }
        return { global, per_bot };
    }
    finally {
        await storage.close();
    }
}
//# sourceMappingURL=allowlist-list.js.map
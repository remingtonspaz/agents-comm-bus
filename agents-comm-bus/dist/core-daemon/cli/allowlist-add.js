import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolvePerBotSelector } from "./allowlist-shared.js";
export async function allowlistAdd(options) {
    const comm = options.comm;
    const storage = await openSqliteStorage(resolveStatePaths().database);
    try {
        const added_at = Date.now();
        const added_by = options.addedBy ?? "cli";
        if (options.scope === "global") {
            const rec = {
                comm,
                sender_id: options.user,
                added_at,
                added_by,
                note: options.note,
            };
            await storage.addAllowlistGlobal(rec);
            return { scope: "global", ...rec };
        }
        const selector = {
            comm,
            botId: options.botId,
            agent: options.agent,
            project: options.project,
            accountLabel: options.accountLabel,
        };
        const { bot_user_id } = await resolvePerBotSelector(storage, selector);
        const rec = {
            comm,
            bot_user_id,
            sender_id: options.user,
            added_at,
            added_by,
            note: options.note,
        };
        await storage.addAllowlistPerBot(rec);
        return { scope: "per-bot", ...rec };
    }
    finally {
        await storage.close();
    }
}
//# sourceMappingURL=allowlist-add.js.map
import { normalizeProjectPath } from "../project-path.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
export async function accountList(options = {}) {
    const storage = await openSqliteStorage(resolveStatePaths().database);
    const rows = await storage.listAccountRegistrations({
        project: options.project === undefined ? undefined : normalizeProjectPath(options.project),
        comm: options.comm,
        agent: options.agent,
    });
    await storage.close();
    return rows;
}
//# sourceMappingURL=account-list.js.map
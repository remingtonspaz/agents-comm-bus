import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
export async function accountRemove(options) {
    const storage = await openSqliteStorage(resolveStatePaths().database);
    await storage.deleteAccountRegistration(options.project, (options.comm ?? "telegram"), options.agent, options.accountLabel);
    await storage.close();
}
//# sourceMappingURL=account-remove.js.map
import type { AgentId, CommId } from "../../../packages/core-contracts/dist/index.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export interface AccountRemoveOptions {
  project: string;
  comm?: string;
  agent: string;
  accountLabel: string;
}

export async function accountRemove(options: AccountRemoveOptions): Promise<void> {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  await storage.deleteAccountRegistration(
    options.project,
    (options.comm ?? "telegram") as CommId,
    options.agent as AgentId,
    options.accountLabel,
  );
  await storage.close();
}

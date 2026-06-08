import type { AgentId, CommId } from "agents-comm-bus-core";
import { normalizeProjectPath } from "../project-path.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export interface AccountListOptions {
  project?: string;
  comm?: string;
  agent?: string;
}

export async function accountList(options: AccountListOptions = {}) {
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const rows = await storage.listAccountRegistrations({
    project: options.project === undefined ? undefined : normalizeProjectPath(options.project),
    comm: options.comm as CommId | undefined,
    agent: options.agent as AgentId | undefined,
  });
  await storage.close();
  return rows;
}

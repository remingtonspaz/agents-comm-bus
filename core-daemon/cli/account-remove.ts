import type { AgentId, CommId } from "agents-comm-bus-core";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export interface AccountRemoveOptions {
  project?: string;
  comm?: string;
  agent?: string;
  accountLabel?: string;
  botId?: string;
  stateRoot?: string;
}

export async function accountRemove(options: AccountRemoveOptions): Promise<void> {
  const comm = (options.comm ?? "telegram") as CommId;
  const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
  try {
    if (options.botId) {
      const row = await storage.getAccountByBot(comm, options.botId);
      if (!row) {
        throw new Error(
          `no account registration found for (comm=${comm}, bot-id=${options.botId}); ` +
            "run `agents-comm account-list` to inspect registered accounts",
        );
      }
      await storage.deleteAccountRegistration(row.project, row.comm, row.agent, row.account_label);
      return;
    }

    if (!options.accountLabel) {
      throw new Error(
        `account-remove requires --bot-id or --account-label for ${comm}; ` +
          "run `agents-comm account-list` to inspect registered accounts",
      );
    }

    const candidates = await storage.listAccountRegistrations({
      project: options.project,
      comm,
      agent: options.agent as AgentId | undefined,
    });
    const matches = candidates.filter((row) => row.account_label === options.accountLabel);
    if (matches.length === 0) {
      throw new Error(
        `no account registration found for ` +
          `(comm=${comm}, account-label=${options.accountLabel}` +
          `${options.agent ? `, agent=${options.agent}` : ""}` +
          `${options.project ? `, project=${options.project}` : ""}); ` +
          "use --bot-id, or run `agents-comm account-list` to inspect registered accounts",
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `account label "${options.accountLabel}" is ambiguous for ${comm}; ` +
          `matched bot ids: ${matches.map((row) => row.bot_user_id).join(", ")}. ` +
          "Narrow with --agent/--project or use --bot-id.",
      );
    }
    const [row] = matches;
    await storage.deleteAccountRegistration(row.project, row.comm, row.agent, row.account_label);
  } finally {
    await storage.close();
  }
}

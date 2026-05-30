import type { CommId } from "agents-comm-bus-core";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolveAccountByLabel } from "./account-selector.js";

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

    const row = await resolveAccountByLabel(storage, {
      comm,
      accountLabel: options.accountLabel,
      agent: options.agent,
      project: options.project,
    });
    await storage.deleteAccountRegistration(row.project, row.comm, row.agent, row.account_label);
  } finally {
    await storage.close();
  }
}

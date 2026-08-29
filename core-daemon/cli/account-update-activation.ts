import type {
  AccountActivation,
  AccountActivationUpdateResult,
  AccountRegistration,
  CommId,
} from "agents-comm-bus-core";

import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolveAccountByLabel } from "./account-selector.js";

export interface AccountUpdateActivationOptions {
  comm?: string;
  botId?: string;
  accountLabel?: string;
  agent?: string;
  project?: string;
  activation?: string;
  stateRoot?: string;
}

export type AccountUpdateActivationResult = AccountActivationUpdateResult;

function parseActivation(value: string | undefined): AccountActivation {
  if (value === "eager" || value === "lazy") return value;
  throw new Error("--activation is required and must be eager or lazy");
}

export async function accountUpdateActivation(
  options: AccountUpdateActivationOptions,
): Promise<AccountActivationUpdateResult> {
  const comm = (options.comm ?? "telegram") as CommId;
  const activation = parseActivation(options.activation);

  const storage = await openSqliteStorage(resolveStatePaths({ stateRoot: options.stateRoot }).database);
  try {
    const current = await resolveCurrentAccount(storage, {
      comm,
      botId: options.botId,
      accountLabel: options.accountLabel,
      agent: options.agent,
      project: options.project,
    });

    return storage.updateAccountRegistrationActivation({
      comm,
      bot_user_id: current.bot_user_id,
      activation,
      updated_at: Date.now(),
    });
  } finally {
    await storage.close();
  }
}

async function resolveCurrentAccount(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  selector: {
    comm: CommId;
    botId?: string;
    accountLabel?: string;
    agent?: string;
    project?: string;
  },
): Promise<AccountRegistration> {
  if (selector.botId) {
    const row = await storage.getAccountByBot(selector.comm, selector.botId);
    if (!row) {
      throw new Error(
        `no account registration found for (comm=${selector.comm}, bot-id=${selector.botId}); ` +
          "run `agents-comm account-list` to inspect registered accounts",
      );
    }
    return row;
  }

  if (!selector.accountLabel) {
    throw new Error(
      `account-update-activation requires --bot-id or --account-label for ${selector.comm}; ` +
        "run `agents-comm account-list` to inspect registered accounts",
    );
  }
  return resolveAccountByLabel(storage, {
    comm: selector.comm,
    accountLabel: selector.accountLabel,
    agent: selector.agent,
    project: selector.project,
  });
}

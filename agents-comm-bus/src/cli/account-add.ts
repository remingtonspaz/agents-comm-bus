import {
  SCHEMA_VERSION_ACCOUNT,
  type AccountRegistration,
  type AgentId,
  type CommId,
} from "../../../agents-comm-bus-core/dist/index.js";
import { probeTelegramIdentity } from "../adapters/comm/telegram/adapter.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export interface AccountAddOptions {
  project: string;
  agent: string;
  accountLabel: string;
  comm?: string;
  botToken?: string;
  credentialsRef?: string;
}

export async function accountAdd(options: AccountAddOptions): Promise<AccountRegistration> {
  const comm = (options.comm ?? "telegram") as CommId;
  if (comm !== "telegram") {
    throw new Error(`unsupported comm for phase 1 account-add: ${comm}`);
  }
  const botToken = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN or --bot-token is required for telegram account-add");
  }
  const identity = await probeTelegramIdentity(botToken);
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const now = Date.now();
  const registration: AccountRegistration = {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: options.project,
    comm,
    agent: options.agent as AgentId,
    account_label: options.accountLabel,
    bot_user_id: identity.bot_user_id,
    bot_username: identity.bot_username,
    credentials_ref: options.credentialsRef ?? "env:TELEGRAM_BOT_TOKEN",
    created_at: now,
    updated_at: now,
    metadata: { source: "account-add" },
  };
  await storage.putAccountRegistration(registration);
  await storage.close();
  return registration;
}

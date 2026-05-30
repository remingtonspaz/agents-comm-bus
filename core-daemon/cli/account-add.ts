import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SCHEMA_VERSION_ACCOUNT,
  type AccountRegistration,
  type AgentId,
  type CommId,
} from "agents-comm-bus-core";
import { probeTelegramIdentity } from "../../adapters/telegram/adapter.js";
import { resolveStatePaths, resolveTokenFilePath } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export interface AccountAddOptions {
  project: string;
  agent: string;
  accountLabel: string;
  comm?: string;
  botToken?: string;
  credentialsRef?: string;
  stateRoot?: string;
  probeIdentity?: typeof probeTelegramIdentity;
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
  const identity = await (options.probeIdentity ?? probeTelegramIdentity)(botToken);
  const paths = resolveStatePaths({ stateRoot: options.stateRoot });
  await mkdir(paths.root, { recursive: true });
  const storage = await openSqliteStorage(paths.database);
  try {
    const labelMatches = await storage.listAccountRegistrations({
      project: options.project,
      comm,
      agent: options.agent as AgentId,
    });
    const existingLabel = labelMatches.find((row) => row.account_label === options.accountLabel);
    if (existingLabel) {
      throw new Error(
        `${comm} account label ${options.accountLabel} is already registered as ` +
          `bot_id=${existingLabel.bot_user_id} for project=${options.project}, ` +
          `agent=${options.agent}; use account-remove before re-adding, or an ` +
          `account-update command when available.`,
      );
    }

    const existing = await storage.getAccountByBot(comm, identity.bot_user_id);
    if (existing) {
      throw new Error(
        `${comm} bot id ${identity.bot_user_id} is already registered as ` +
          `project=${existing.project}, agent=${existing.agent}, ` +
          `account_label=${existing.account_label}; use account-list to inspect it ` +
          `or account-remove --comm ${comm} --bot-id ${identity.bot_user_id} before re-adding.`,
      );
    }

    const credentialsRef = options.credentialsRef ?? await writeTokenFile({
      stateRoot: options.stateRoot,
      comm,
      project: options.project,
      agent: options.agent,
      accountId: identity.bot_user_id,
      botToken,
    });
    const now = Date.now();
    const registration: AccountRegistration = {
      schema_version: SCHEMA_VERSION_ACCOUNT,
      project: options.project,
      comm,
      agent: options.agent as AgentId,
      account_label: options.accountLabel,
      bot_user_id: identity.bot_user_id,
      bot_username: identity.bot_username,
      credentials_ref: credentialsRef,
      created_at: now,
      updated_at: now,
      metadata: { source: "account-add" },
    };
    await storage.putAccountRegistration(registration);
    return registration;
  } finally {
    await storage.close();
  }
}

async function writeTokenFile(options: {
  stateRoot?: string;
  comm: CommId;
  project: string;
  agent: string;
  accountId: string;
  botToken: string;
}): Promise<string> {
  const tokenFile = resolveTokenFilePath({
    stateRoot: options.stateRoot,
    comm: options.comm,
    project: options.project,
    agent: options.agent,
    accountId: options.accountId,
  });
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(
    tokenFile,
    `${JSON.stringify({ botToken: options.botToken }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    await chmod(tokenFile, 0o600);
  } catch {
    // Best effort: Windows ACL inheritance is still per-user under the daemon state root.
  }
  return `file:${tokenFile}`;
}

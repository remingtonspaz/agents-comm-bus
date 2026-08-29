import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

import {
  SCHEMA_VERSION_ACCOUNT,
  type AccountRegistration,
  type AgentId,
  type CommId,
} from "agents-comm-bus-core";
import { normalizeProjectPath } from "../project-path.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolveCredentialInput } from "./credential-input.js";
import { probeIdentityViaDaemon, type ProbeIdentity } from "./identity-probe.js";
import { writeCredentialsFile } from "./token-file.js";

export interface AccountAddOptions {
  project: string;
  agent: string;
  accountLabel: string;
  comm?: string;
  botToken?: string;
  credentials?: Record<string, unknown>;
  credentialsFile?: string;
  credentialsJson?: string;
  /**
   * Explicit synthetic account id for comms without a remote identity to
   * probe (e.g. curl, AGE-50). Ignored by comms that probe a real platform
   * identity (telegram getMe, matrix whoami, ...).
   */
  accountId?: string;
  stateRoot?: string;
  probeIdentity?: ProbeIdentity;
}

export async function accountAdd(options: AccountAddOptions): Promise<AccountRegistration> {
  const project = normalizeProjectPath(options.project);
  const comm = (options.comm ?? "telegram") as CommId;
  const credentials = await resolveCredentialInput({
    botToken: options.botToken,
    credentials: options.credentials,
    credentialsFile: options.credentialsFile,
    credentialsJson: options.credentialsJson,
  });
  const identity = await (options.probeIdentity ?? ((creds, accountId) =>
    probeIdentityViaDaemon({
      comm,
      credentials: creds,
      accountId,
      agent: options.agent,
      stateRoot: options.stateRoot,
    })))(credentials, options.accountId);
  const paths = resolveStatePaths({ stateRoot: options.stateRoot });
  await mkdir(paths.root, { recursive: true });
  const storage = await openSqliteStorage(paths.database);
  try {
    const labelMatches = await storage.listAccountRegistrations({
      project,
      comm,
      agent: options.agent as AgentId,
    });
    const existingLabel = labelMatches.find((row) => row.account_label === options.accountLabel);
    if (existingLabel) {
      throw new Error(
        `${comm} account label ${options.accountLabel} is already registered as ` +
          `bot_id=${existingLabel.bot_user_id} for project=${project}, ` +
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

    const credentialsRef = await writeCredentialsFile({
      stateRoot: options.stateRoot,
      comm,
      project,
      agent: options.agent,
      accountId: identity.bot_user_id,
      credentials,
    });
    const now = Date.now();
    const registration: AccountRegistration = {
      schema_version: SCHEMA_VERSION_ACCOUNT,
      registration_id: `reg_${randomBytes(16).toString("hex")}`,
      project,
      comm,
      agent: options.agent as AgentId,
      account_label: options.accountLabel,
      bot_user_id: identity.bot_user_id,
      bot_username: identity.bot_username ?? undefined,
      credentials_ref: credentialsRef,
      activation: "lazy",
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

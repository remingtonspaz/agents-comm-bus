import type {
  AccountRegistration,
  AgentId,
  CommId,
  Storage,
} from "agents-comm-bus-core";

export interface AccountLabelSelector {
  comm: CommId;
  accountLabel: string;
  agent?: string;
  project?: string;
}

export async function resolveAccountByLabel(
  storage: Storage,
  selector: AccountLabelSelector,
): Promise<AccountRegistration> {
  const candidates = await storage.listAccountRegistrations({
    project: selector.project,
    comm: selector.comm,
    agent: selector.agent as AgentId | undefined,
  });
  const matches = candidates.filter((row) => row.account_label === selector.accountLabel);
  if (matches.length === 0) {
    throw new Error(
      `no account registration found for ` +
        `(comm=${selector.comm}, account-label=${selector.accountLabel}` +
        `${selector.agent ? `, agent=${selector.agent}` : ""}` +
        `${selector.project ? `, project=${selector.project}` : ""}); ` +
        "use --bot-id, or run `agents-comm account-list` to inspect registered accounts",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `account label "${selector.accountLabel}" is ambiguous for ${selector.comm}; ` +
        `matched bot ids: ${matches.map((row) => row.bot_user_id).join(", ")}. ` +
        "Narrow with --agent/--project or use --bot-id.",
    );
  }
  return matches[0];
}

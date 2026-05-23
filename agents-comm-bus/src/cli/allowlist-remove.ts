import type { CommId } from "../../../packages/core-contracts/dist/index.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolvePerBotSelector, type PerBotSelector } from "./allowlist-shared.js";

export interface AllowlistRemoveOptions {
  comm: string;
  user: string;
  scope: "global" | "per-bot";
  botId?: string;
  agent?: string;
  project?: string;
  accountLabel?: string;
}

export type AllowlistRemoveResult =
  | { scope: "global"; comm: string; sender_id: string }
  | { scope: "per-bot"; comm: string; bot_user_id: string; sender_id: string };

export async function allowlistRemove(
  options: AllowlistRemoveOptions,
): Promise<AllowlistRemoveResult> {
  const comm = options.comm as CommId;
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    if (options.scope === "global") {
      await storage.removeAllowlistGlobal(comm, options.user);
      return { scope: "global", comm, sender_id: options.user };
    }
    const selector: PerBotSelector = {
      comm,
      botId: options.botId,
      agent: options.agent,
      project: options.project,
      accountLabel: options.accountLabel,
    };
    const { bot_user_id } = await resolvePerBotSelector(storage, selector);
    await storage.removeAllowlistPerBot(comm, bot_user_id, options.user);
    return { scope: "per-bot", comm, bot_user_id, sender_id: options.user };
  } finally {
    await storage.close();
  }
}

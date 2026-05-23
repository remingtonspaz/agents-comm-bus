import type { CommId } from "../../packages/core-contracts/dist/index.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolvePerBotSelector, type PerBotSelector } from "./allowlist-shared.js";

export interface AllowlistAddOptions {
  comm: string;
  user: string;
  note?: string;
  scope: "global" | "per-bot";
  botId?: string;
  agent?: string;
  project?: string;
  accountLabel?: string;
  addedBy?: string;
}

export type AllowlistAddResult =
  | { scope: "global"; comm: string; sender_id: string; added_at: number; note?: string; added_by?: string }
  | {
      scope: "per-bot";
      comm: string;
      bot_user_id: string;
      sender_id: string;
      added_at: number;
      note?: string;
      added_by?: string;
    };

export async function allowlistAdd(
  options: AllowlistAddOptions,
): Promise<AllowlistAddResult> {
  const comm = options.comm as CommId;
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const added_at = Date.now();
    const added_by = options.addedBy ?? "cli";
    if (options.scope === "global") {
      const rec = {
        comm,
        sender_id: options.user,
        added_at,
        added_by,
        note: options.note,
      };
      await storage.addAllowlistGlobal(rec);
      return { scope: "global", ...rec };
    }
    const selector: PerBotSelector = {
      comm,
      botId: options.botId,
      agent: options.agent,
      project: options.project,
      accountLabel: options.accountLabel,
    };
    const { bot_user_id } = await resolvePerBotSelector(storage, selector);
    const rec = {
      comm,
      bot_user_id,
      sender_id: options.user,
      added_at,
      added_by,
      note: options.note,
    };
    await storage.addAllowlistPerBot(rec);
    return { scope: "per-bot", ...rec };
  } finally {
    await storage.close();
  }
}

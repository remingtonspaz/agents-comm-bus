import type {
  AllowlistGlobalEntry,
  AllowlistPerBotEntry,
  CommId,
} from "../../packages/core-contracts/dist/index.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";
import { resolvePerBotSelector, type PerBotSelector } from "./allowlist-shared.js";

export type AllowlistScopeFilter = "global" | "per-bot" | "all";

export interface AllowlistListOptions {
  comm?: string;
  scope?: AllowlistScopeFilter;
  /** Per-bot selector. If `botId`/agent fields are set, restrict to that bot. */
  botId?: string;
  agent?: string;
  project?: string;
  accountLabel?: string;
}

export interface AllowlistListResult {
  global: AllowlistGlobalEntry[];
  per_bot: AllowlistPerBotEntry[];
}

export async function allowlistList(
  options: AllowlistListOptions = {},
): Promise<AllowlistListResult> {
  const scope: AllowlistScopeFilter = options.scope ?? "all";
  const comm = options.comm as CommId | undefined;
  const storage = await openSqliteStorage(resolveStatePaths().database);
  try {
    const global: AllowlistGlobalEntry[] =
      scope === "per-bot" ? [] : await storage.listAllowlistGlobal({ comm });

    if (scope === "global") {
      return { global, per_bot: [] };
    }

    let per_bot: AllowlistPerBotEntry[];
    const hasPerBotSelector = Boolean(
      options.botId || options.agent || options.project,
    );
    if (hasPerBotSelector) {
      if (!comm) {
        throw new Error("--comm is required when selecting per-bot rows");
      }
      const selector: PerBotSelector = {
        comm,
        botId: options.botId,
        agent: options.agent,
        project: options.project,
        accountLabel: options.accountLabel,
      };
      const { bot_user_id } = await resolvePerBotSelector(storage, selector);
      per_bot = await storage.listAllowlistPerBot({ comm, bot_user_id });
    } else {
      per_bot = await storage.listAllowlistPerBot({ comm });
    }
    return { global, per_bot };
  } finally {
    await storage.close();
  }
}

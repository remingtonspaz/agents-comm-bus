import type { AllowlistGlobalEntry, AllowlistPerBotEntry } from "agents-comm-bus-core";
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
export declare function allowlistList(options?: AllowlistListOptions): Promise<AllowlistListResult>;
//# sourceMappingURL=allowlist-list.d.ts.map
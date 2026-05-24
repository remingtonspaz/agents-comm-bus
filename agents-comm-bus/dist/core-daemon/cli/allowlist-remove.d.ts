export interface AllowlistRemoveOptions {
    comm: string;
    user: string;
    scope: "global" | "per-bot";
    botId?: string;
    agent?: string;
    project?: string;
    accountLabel?: string;
}
export type AllowlistRemoveResult = {
    scope: "global";
    comm: string;
    sender_id: string;
} | {
    scope: "per-bot";
    comm: string;
    bot_user_id: string;
    sender_id: string;
};
export declare function allowlistRemove(options: AllowlistRemoveOptions): Promise<AllowlistRemoveResult>;
//# sourceMappingURL=allowlist-remove.d.ts.map
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
export type AllowlistAddResult = {
    scope: "global";
    comm: string;
    sender_id: string;
    added_at: number;
    note?: string;
    added_by?: string;
} | {
    scope: "per-bot";
    comm: string;
    bot_user_id: string;
    sender_id: string;
    added_at: number;
    note?: string;
    added_by?: string;
};
export declare function allowlistAdd(options: AllowlistAddOptions): Promise<AllowlistAddResult>;
//# sourceMappingURL=allowlist-add.d.ts.map
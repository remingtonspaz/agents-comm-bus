export interface BotIdentity {
    bot_user_id: string;
    bot_username?: string | null;
}
export type ProbeIdentity = (botToken: string) => Promise<BotIdentity>;
export declare function probeIdentityViaDaemon(options: {
    comm: string;
    botToken: string;
    agent?: string;
    stateRoot?: string;
    timeoutMs?: number;
}): Promise<BotIdentity>;
//# sourceMappingURL=identity-probe.d.ts.map
export interface BotIdentity {
    bot_user_id: string;
    bot_username?: string | null;
}
export type ProbeIdentity = (credentials: Record<string, unknown>, accountId?: string) => Promise<BotIdentity>;
export declare function probeIdentityViaDaemon(options: {
    comm: string;
    credentials: Record<string, unknown>;
    /**
     * Explicit synthetic account id for comms without a remote identity to
     * probe (e.g. curl, AGE-50). Comms that probe a real platform identity
     * ignore it.
     */
    accountId?: string;
    agent?: string;
    stateRoot?: string;
    timeoutMs?: number;
}): Promise<BotIdentity>;
//# sourceMappingURL=identity-probe.d.ts.map
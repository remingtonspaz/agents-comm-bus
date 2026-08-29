import type { AccountActivationUpdateResult } from "agents-comm-bus-core";
export interface AccountUpdateActivationOptions {
    comm?: string;
    botId?: string;
    accountLabel?: string;
    agent?: string;
    project?: string;
    activation?: string;
    stateRoot?: string;
}
export type AccountUpdateActivationResult = AccountActivationUpdateResult;
export declare function accountUpdateActivation(options: AccountUpdateActivationOptions): Promise<AccountActivationUpdateResult>;
//# sourceMappingURL=account-update-activation.d.ts.map
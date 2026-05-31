import type { AccountRelabelResult } from "agents-comm-bus-core";
export interface AccountRelabelOptions {
    comm?: string;
    botId?: string;
    accountLabel?: string;
    agent?: string;
    project?: string;
    newAccountLabel?: string;
    stateRoot?: string;
}
export type { AccountRelabelResult };
export declare function accountRelabel(options: AccountRelabelOptions): Promise<AccountRelabelResult>;
//# sourceMappingURL=account-relabel.d.ts.map
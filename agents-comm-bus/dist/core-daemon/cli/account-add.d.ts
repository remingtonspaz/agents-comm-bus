import { type AccountRegistration } from "agents-comm-bus-core";
export interface AccountAddOptions {
    project: string;
    agent: string;
    accountLabel: string;
    comm?: string;
    botToken?: string;
    credentialsRef?: string;
}
export declare function accountAdd(options: AccountAddOptions): Promise<AccountRegistration>;
//# sourceMappingURL=account-add.d.ts.map
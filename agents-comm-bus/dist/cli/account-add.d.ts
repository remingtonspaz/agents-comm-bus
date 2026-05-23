import { type AccountRegistration } from "../../../packages/core-contracts/dist/index.js";
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
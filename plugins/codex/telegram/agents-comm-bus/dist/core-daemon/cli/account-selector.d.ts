import type { AccountRegistration, CommId, Storage } from "agents-comm-bus-core";
export interface AccountLabelSelector {
    comm: CommId;
    accountLabel: string;
    agent?: string;
    project?: string;
}
export declare function resolveAccountByLabel(storage: Storage, selector: AccountLabelSelector): Promise<AccountRegistration>;
//# sourceMappingURL=account-selector.d.ts.map
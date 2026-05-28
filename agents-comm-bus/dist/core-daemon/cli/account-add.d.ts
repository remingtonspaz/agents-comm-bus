import { type AccountRegistration } from "agents-comm-bus-core";
import { probeTelegramIdentity } from "../../adapters/telegram/adapter.js";
export interface AccountAddOptions {
    project: string;
    agent: string;
    accountLabel: string;
    comm?: string;
    botToken?: string;
    credentialsRef?: string;
    stateRoot?: string;
    probeIdentity?: typeof probeTelegramIdentity;
}
export declare function accountAdd(options: AccountAddOptions): Promise<AccountRegistration>;
//# sourceMappingURL=account-add.d.ts.map
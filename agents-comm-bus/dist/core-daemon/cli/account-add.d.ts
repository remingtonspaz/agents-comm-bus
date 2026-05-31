import { type AccountRegistration } from "agents-comm-bus-core";
import { type ProbeIdentity } from "./identity-probe.js";
export interface AccountAddOptions {
    project: string;
    agent: string;
    accountLabel: string;
    comm?: string;
    botToken?: string;
    stateRoot?: string;
    probeIdentity?: ProbeIdentity;
}
export declare function accountAdd(options: AccountAddOptions): Promise<AccountRegistration>;
//# sourceMappingURL=account-add.d.ts.map
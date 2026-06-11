import { type AccountRegistration } from "agents-comm-bus-core";
import { type ProbeIdentity } from "./identity-probe.js";
export interface AccountAddOptions {
    project: string;
    agent: string;
    accountLabel: string;
    comm?: string;
    botToken?: string;
    /**
     * Explicit synthetic account id for comms without a remote identity to
     * probe (e.g. curl, AGE-50). Ignored by comms that probe a real platform
     * identity (telegram getMe, matrix whoami, ...).
     */
    accountId?: string;
    stateRoot?: string;
    probeIdentity?: ProbeIdentity;
}
export declare function accountAdd(options: AccountAddOptions): Promise<AccountRegistration>;
//# sourceMappingURL=account-add.d.ts.map
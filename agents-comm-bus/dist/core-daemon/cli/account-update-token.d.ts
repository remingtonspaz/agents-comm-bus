import type { AccountTokenUpdateResult } from "agents-comm-bus-core";
import { type ProbeIdentity } from "./identity-probe.js";
export interface AccountUpdateTokenOptions {
    comm?: string;
    botId?: string;
    accountLabel?: string;
    agent?: string;
    project?: string;
    botToken?: string;
    credentials?: Record<string, unknown>;
    credentialsFile?: string;
    credentialsJson?: string;
    /**
     * Explicit synthetic account id for comms without a remote identity to
     * probe (e.g. curl, AGE-50). Without it a rotation on such a comm probes
     * the default synthetic id, which can look like a bot change for accounts
     * registered with an explicit id.
     */
    accountId?: string;
    allowBotChange?: boolean;
    stateRoot?: string;
    probeIdentity?: ProbeIdentity;
}
export type AccountUpdateTokenResult = AccountTokenUpdateResult;
export declare function accountUpdateToken(options: AccountUpdateTokenOptions): Promise<AccountTokenUpdateResult>;
//# sourceMappingURL=account-update-token.d.ts.map
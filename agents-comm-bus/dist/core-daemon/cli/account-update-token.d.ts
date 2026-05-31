import type { AccountTokenUpdateResult } from "agents-comm-bus-core";
import { type ProbeIdentity } from "./identity-probe.js";
export interface AccountUpdateTokenOptions {
    comm?: string;
    botId?: string;
    accountLabel?: string;
    agent?: string;
    project?: string;
    botToken?: string;
    allowBotChange?: boolean;
    stateRoot?: string;
    probeIdentity?: ProbeIdentity;
}
export type AccountUpdateTokenResult = AccountTokenUpdateResult;
export declare function accountUpdateToken(options: AccountUpdateTokenOptions): Promise<AccountTokenUpdateResult>;
//# sourceMappingURL=account-update-token.d.ts.map
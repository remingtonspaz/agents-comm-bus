import type { AccountTokenUpdateResult } from "agents-comm-bus-core";
import { probeTelegramIdentity } from "../../adapters/telegram/adapter.js";
export interface AccountUpdateTokenOptions {
    comm?: string;
    botId?: string;
    accountLabel?: string;
    agent?: string;
    project?: string;
    botToken?: string;
    allowBotChange?: boolean;
    stateRoot?: string;
    probeIdentity?: typeof probeTelegramIdentity;
}
export type AccountUpdateTokenResult = AccountTokenUpdateResult;
export declare function accountUpdateToken(options: AccountUpdateTokenOptions): Promise<AccountTokenUpdateResult>;
//# sourceMappingURL=account-update-token.d.ts.map
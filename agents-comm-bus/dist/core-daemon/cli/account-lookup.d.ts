import type { AccountRegistration } from "agents-comm-bus-core";
import { type ProbeIdentity } from "./identity-probe.js";
export interface AccountLookupOptions {
    comm?: string;
    botToken?: string;
    accountId?: string;
    stateRoot?: string;
    probeIdentity?: ProbeIdentity;
}
export interface AccountLookupResult {
    registered: boolean;
    bot_user_id: string;
    bot_username: string | null;
    registration: AccountRegistration | null;
}
export declare function accountLookup(options: AccountLookupOptions): Promise<AccountLookupResult>;
export declare function formatAccountLookup(result: AccountLookupResult): string;
//# sourceMappingURL=account-lookup.d.ts.map
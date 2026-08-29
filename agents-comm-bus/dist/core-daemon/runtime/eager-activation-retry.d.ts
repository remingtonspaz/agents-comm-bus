import type { Storage } from "agents-comm-bus-core";
import type { EnsureRegistrationContext } from "./ensure-registration.js";
export interface EagerActivationRetryScheduler {
    schedule(registration_id: string): void;
    cancel(registration_id: string): void;
    stopAll(): void;
}
export declare function createEagerActivationRetryScheduler(input: {
    storage: Storage;
    ensure: EnsureRegistrationContext;
}): EagerActivationRetryScheduler;
//# sourceMappingURL=eager-activation-retry.d.ts.map
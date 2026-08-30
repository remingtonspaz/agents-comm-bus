import type { AccountRegistration, Session } from "agents-comm-bus-core";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
/**
 * AGE-101: pure discovery-root eligibility for live comm-lease acquire/reclaim.
 * Fail-closed on ambiguous/missing daemon-owner stamps on live owning sessions.
 */
export declare function computeCommLeaseEligibility(input: {
    registration: AccountRegistration;
    discoveryRoot: string;
    sessions: readonly Session[];
    sessionOwnerIsLive: SessionOwnerLiveness;
}): boolean;
//# sourceMappingURL=comm-lease-eligibility.d.ts.map
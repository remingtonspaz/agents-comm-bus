import type { AccountRegistration, AgentId, Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../bus.js";
import type { JsonlAuditStore } from "../storage/audit.js";
import type { ContentAddressedBlobStore } from "../storage/blobs.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { EnsureRegistrationResult } from "./agent-bridge.js";
import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommLeaseArbiter, AgentLeaseProperties } from "./comm-lease.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
export type EnsureRegistrationRetryClass = "permanent" | "transient";
export type { EnsureRegistrationResult } from "./agent-bridge.js";
export interface EnsureRegistrationContext {
    factories: CommAdapterFactory[];
    rescanFactories?: (comm: string) => Promise<CommAdapterFactory | undefined>;
    bus: MessageBus;
    bridges: AgentBridge[];
    storage: Storage;
    env: NodeJS.ProcessEnv;
    blobs: ContentAddressedBlobStore;
    stateRoot: string;
    leaseArbiter: CommLeaseArbiter;
    inFlight: Set<string>;
    audit?: JsonlAuditStore;
    agent?: AgentId;
    agentLeaseProperties?: AgentLeaseProperties;
    discoveryRoot?: string;
    sessionOwnerIsLive?: SessionOwnerLiveness;
    /** AGE-97: schedule bounded retries for eager registrations on transient failure. */
    scheduleEagerRetry?: (registration_id: string) => void;
}
/**
 * AGE-97: exact-single-registration ensure keyed on `registration_id`. Never
 * touches `activeScopes` or session-scope loops — use for eager activation only.
 */
export declare function ensureRegistrationForAccount(registration: AccountRegistration, input: EnsureRegistrationContext): Promise<EnsureRegistrationResult>;
export declare function ensureRegistrationById(registration_id: string, input: EnsureRegistrationContext): Promise<EnsureRegistrationResult | null>;
export declare function reconcileEagerRegistrations(input: {
    storage: Storage;
    ensure: EnsureRegistrationContext;
}): Promise<EnsureRegistrationResult[]>;
//# sourceMappingURL=ensure-registration.d.ts.map
import type { AccountId, AccountRegistration, CommAdapter, CommId, Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../bus.js";
import type { JsonlAuditStore } from "../storage/audit.js";
import type { ContentAddressedBlobStore } from "../storage/blobs.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommLeaseArbiter } from "./comm-lease.js";
import type { CredentialResolution } from "./credential-resolution.js";
import type { SessionOwnerLiveness } from "./session-owner-liveness.js";
export declare function adapterMapKey(commId: CommId, accountId: AccountId | string): string;
export declare function unresolvedCredentialsReason(ref: string, action?: string): string;
export declare function logInvalidCredentialResolution(registration: AccountRegistration, commId: CommId, resolution: Extract<CredentialResolution, {
    status: "invalid";
}>): void;
export declare function appendCredentialResolutionFailedAudit(audit: JsonlAuditStore | undefined, registration: AccountRegistration, commId: CommId, resolution: Extract<CredentialResolution, {
    status: "invalid";
}>): Promise<void>;
export declare function createAdapterFromRegistration(input: {
    factory: CommAdapterFactory;
    registration: AccountRegistration;
    env: NodeJS.ProcessEnv;
    blobs: ContentAddressedBlobStore;
    stateRoot: string;
    storage?: Storage;
    leaseArbiter: CommLeaseArbiter;
    /** AGE-101: discovery-root eligibility consult for live lease acquire. */
    discoveryRoot?: string;
    sessionOwnerIsLive?: SessionOwnerLiveness;
}): Promise<{
    adapter: CommAdapter | null;
    resolution: CredentialResolution;
}>;
/** AGE-101: shared unregister → detach → stop → release lease removal path. */
export declare function removeLiveAdapter(input: {
    bus: MessageBus;
    bridges: AgentBridge[];
    leaseArbiter: CommLeaseArbiter;
    commId: CommId;
    accountId: AccountId | string;
}): Promise<void>;
export type AddAdapterForRegistrationResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
    retryClass: "permanent";
    resolution: CredentialResolution;
} | {
    ok: false;
    reason: string;
    retryClass: "transient";
    resolution?: CredentialResolution;
};
/**
 * AGE-38 / AGE-97: construct, register, wire bridges, start, rollback on failure.
 */
export declare function addAdapterForRegistration(input: {
    factory: CommAdapterFactory;
    registration: AccountRegistration;
    bus: MessageBus;
    bridges: AgentBridge[];
    env: NodeJS.ProcessEnv;
    blobs: ContentAddressedBlobStore;
    stateRoot: string;
    storage: Storage;
    leaseArbiter: CommLeaseArbiter;
    discoveryRoot?: string;
    sessionOwnerIsLive?: SessionOwnerLiveness;
}): Promise<AddAdapterForRegistrationResult>;
//# sourceMappingURL=comm-adapter-lifecycle.d.ts.map
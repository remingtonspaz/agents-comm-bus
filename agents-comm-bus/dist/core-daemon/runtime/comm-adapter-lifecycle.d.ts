import type { AccountId, AccountRegistration, CommAdapter, CommId, Storage } from "agents-comm-bus-core";
import type { MessageBus } from "../bus.js";
import type { JsonlAuditStore } from "../storage/audit.js";
import type { ContentAddressedBlobStore } from "../storage/blobs.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { CommAdapterFactory } from "./comm-factory.js";
import type { CommLeaseArbiter } from "./comm-lease.js";
import type { CredentialResolution } from "./credential-resolution.js";
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
}): Promise<{
    adapter: CommAdapter | null;
    resolution: CredentialResolution;
}>;
export type AddAdapterForRegistrationResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
    retryClass: "permanent" | "transient";
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
}): Promise<AddAdapterForRegistrationResult>;
//# sourceMappingURL=comm-adapter-lifecycle.d.ts.map
import { computeCommLeaseEligibility } from "./comm-lease-eligibility.js";
import { wrapWithLease } from "./comm-lease.js";
export function adapterMapKey(commId, accountId) {
    return `${commId}:${accountId}`;
}
export function unresolvedCredentialsReason(ref, action = "resolve") {
    if (ref.startsWith("env:")) {
        return `could not ${action} credentials_ref=${ref}: env: credential refs are retired; ` +
            "rerun account-update-token with --bot-token to create a daemon-owned file: ref";
    }
    return `could not ${action} credentials_ref=${ref}`;
}
export function logInvalidCredentialResolution(registration, commId, resolution) {
    const pathSuffix = resolution.path ? ` [${resolution.path}]` : "";
    console.error(`agents-comm-bus: credential file for ${commId} account ${registration.account_label} ` +
        `(project ${registration.project}) exists but failed to resolve: ${resolution.reason}${pathSuffix}`);
}
export async function appendCredentialResolutionFailedAudit(audit, registration, commId, resolution) {
    await audit
        ?.append({
        timestamp: Date.now(),
        kind: "credential_resolution_failed",
        agent: registration.agent,
        detail: {
            comm: commId,
            account_id: registration.bot_user_id,
            account_label: registration.account_label,
            project: registration.project,
            credentials_ref: registration.credentials_ref,
            failure_kind: resolution.failureKind,
            reason: resolution.reason,
            credential_path: resolution.path ?? null,
        },
    })
        .catch(() => { });
}
export async function createAdapterFromRegistration(input) {
    const resolved = await input.factory.resolveCredentials(input.registration, input.env, {
        storage: input.storage,
        stateRoot: input.stateRoot,
    });
    if (resolved.status !== "ok") {
        return { adapter: null, resolution: resolved };
    }
    const adapter = input.factory.create(resolved.credentials, input.registration.bot_user_id, {
        blobs: input.blobs,
        stateRoot: input.stateRoot,
        registrationId: input.registration.registration_id,
        storage: input.storage,
    });
    if (adapter.exclusiveResource?.() != null) {
        const leaseEligible = input.storage &&
            input.discoveryRoot &&
            input.sessionOwnerIsLive
            ? async () => {
                const sessions = await input.storage.listSessions({
                    project: input.registration.project,
                    agent: input.registration.agent,
                    status: "active",
                });
                return computeCommLeaseEligibility({
                    registration: input.registration,
                    discoveryRoot: input.discoveryRoot,
                    sessions,
                    sessionOwnerIsLive: input.sessionOwnerIsLive,
                });
            }
            : undefined;
        return {
            adapter: wrapWithLease(adapter, input.leaseArbiter, { leaseEligible }),
            resolution: resolved,
        };
    }
    return { adapter, resolution: resolved };
}
/** AGE-101: shared unregister → detach → stop → release lease removal path. */
export async function removeLiveAdapter(input) {
    const accountId = input.accountId;
    const adapter = input.bus.unregisterComm(input.commId, accountId);
    for (const bridge of input.bridges) {
        bridge.detachComm?.(input.commId, accountId);
    }
    if (adapter) {
        try {
            await adapter.stop();
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to stop ${input.commId}/${accountId} on scope release: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const resource = adapter?.exclusiveResource?.();
    if (resource) {
        await input.leaseArbiter.release(input.commId, resource.resourceId).catch(() => { });
    }
}
/**
 * AGE-38 / AGE-97: construct, register, wire bridges, start, rollback on failure.
 */
export async function addAdapterForRegistration(input) {
    try {
        const { adapter, resolution } = await createAdapterFromRegistration({
            factory: input.factory,
            registration: input.registration,
            env: input.env,
            blobs: input.blobs,
            stateRoot: input.stateRoot,
            storage: input.storage,
            leaseArbiter: input.leaseArbiter,
            discoveryRoot: input.discoveryRoot,
            sessionOwnerIsLive: input.sessionOwnerIsLive,
        });
        if (!adapter) {
            if (resolution.status === "invalid") {
                logInvalidCredentialResolution(input.registration, input.factory.commId, resolution);
            }
            return {
                ok: false,
                reason: resolution.status === "invalid"
                    ? resolution.reason
                    : unresolvedCredentialsReason(input.registration.credentials_ref),
                retryClass: "permanent",
                resolution,
            };
        }
        const accountId = input.registration.bot_user_id;
        try {
            input.bus.registerComm(adapter);
            for (const bridge of input.bridges) {
                bridge.attachComm?.(adapter);
            }
            await adapter.start();
            return { ok: true };
        }
        catch (error) {
            await adapter.stop().catch(() => { });
            input.bus.unregisterComm(input.registration.comm, accountId);
            for (const bridge of input.bridges) {
                bridge.detachComm?.(input.registration.comm, accountId);
            }
            return {
                ok: false,
                reason: `failed to start adapter: ${error instanceof Error ? error.message : String(error)}`,
                retryClass: "transient",
                resolution,
            };
        }
    }
    catch (error) {
        return {
            ok: false,
            reason: `adapter construction failed: ${error instanceof Error ? error.message : String(error)}`,
            retryClass: "transient",
        };
    }
}
//# sourceMappingURL=comm-adapter-lifecycle.js.map
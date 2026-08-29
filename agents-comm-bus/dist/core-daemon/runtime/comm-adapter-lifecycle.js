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
        return { adapter: wrapWithLease(adapter, input.leaseArbiter), resolution: resolved };
    }
    return { adapter, resolution: resolved };
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
/**
 * PiBridge — Pi-side of the agents-comm-bus daemon.
 *
 * Hosts the `pi_*` IPC methods, Pi-scoped inbound draining, and explicit lease
 * release. Pi has no wake watcher (the extension polls + injects itself), so
 * this bridge is simpler than Claude/Codex.
 */
import { SCHEMA_VERSION_SESSION, } from "agents-comm-bus-core";
import { sessionLeaseOwnerWithDaemon } from "../../runtime/agent-bridge.js";
import { normalizeProjectPath } from "../../project-path.js";
import { accountLabelScopeFromParams, filterRegistrationsForSession, } from "../../session-label-scope.js";
import { removePendingInboundEntries } from "../../runtime/durable-inbound.js";
import { createSessionOwnerLiveness, } from "../../runtime/session-owner-liveness.js";
const PI_IPC_METHODS = new Set([
    "pi_register_session",
    "pi_drain_inbound",
    "pi_unregister_session",
]);
export class PiBridge {
    options;
    agentId = "pi";
    ipcMethods = PI_IPC_METHODS;
    sessionOwnerIsLive;
    constructor(options) {
        this.options = options;
        this.sessionOwnerIsLive =
            options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
    }
    attach(_comms) {
        // Pi wires no resolve-sink and no onCallback yet (Phase 1).
    }
    async handleIpcMethod(method, params, ctx) {
        switch (method) {
            case "pi_register_session":
                return this.registerSession(params, ctx.socket);
            case "pi_drain_inbound":
                return this.drainInbound(params);
            case "pi_unregister_session":
                return this.unregisterSession(params);
            default:
                throw new Error(`PiBridge does not handle IPC method: ${method}`);
        }
    }
    async ensureCommsBestEffort(project, accountLabelScope) {
        try {
            await this.options.ensureCommsForSession?.(project, this.agentId, {
                accountLabelScope: accountLabelScope ?? null,
            });
        }
        catch (error) {
            console.error(`agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async ownedAccountKeys(session) {
        if (session) {
            const sess = await this.options.storage.getSession(session);
            if (!sess)
                return new Set();
            const [registrations, sessions] = await Promise.all([
                this.options.storage.listAccountRegistrations({
                    project: sess.project,
                    agent: this.agentId,
                }),
                this.options.storage.listSessions({
                    project: sess.project,
                    agent: this.agentId,
                    status: "active",
                }),
            ]);
            const scoped = filterRegistrationsForSession(registrations, sess, sessions, this.sessionOwnerIsLive);
            return new Set(scoped.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
        }
        const registrations = await this.options.storage.listAccountRegistrations({
            agent: this.agentId,
        });
        return new Set(registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
    }
    assertCallerProjectMatchesStored(session, storedProject, params) {
        if (typeof params.project !== "string" || params.project.length === 0)
            return;
        const callerProject = normalizeProjectPath(params.project);
        if (callerProject !== storedProject) {
            throw new Error(`project mismatch for session ${session}: caller ${callerProject} != stored ${storedProject}`);
        }
    }
    async registerSession(params, socket) {
        const session = requiredString(params.session, "session");
        const project = normalizeProjectPath(requiredString(params.project, "project"));
        const connectionId = requiredString(params.connection_id, "connection_id");
        const now = Date.now();
        const accountLabelScope = accountLabelScopeFromParams(params);
        await this.options.storage.upsertSession({
            schema_version: SCHEMA_VERSION_SESSION,
            session_id: session,
            agent: "pi",
            project,
            created_at: now,
            lease_holder_connection_id: null,
            lease_acquired_at: null,
            lease_released_at: null,
            lease_owner_process_pid: null,
            lease_owner_process_label: null,
            lease_owner_process_registered_at: null,
            lease_owner_daemon_discovery_root: null,
            lease_owner_daemon_checkout_root: null,
            lease_owner_daemon_state_root: null,
            lease_owner_daemon_bin: null,
            lease_owner_daemon_authority_rank: null,
            most_recent_inbound_conversation_id: null,
            account_label_scope: accountLabelScope,
            status: "active",
        });
        const leaseOwner = this.options.daemonOwner
            ? sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params), this.options.daemonOwner)
            : sessionLeaseOwnerFromParams(params);
        const acquired = await this.options.storage.acquireSessionLease(session, connectionId, now, leaseOwner);
        if (!acquired) {
            await this.ensureCommsBestEffort(project, accountLabelScope);
            return { ok: false, reason: "pi session lease already held" };
        }
        socket?.once("close", () => {
            void this.options.storage.releaseSessionConnectionLeasePreservingOwner(session, connectionId, Date.now());
        });
        // AGE-38/AGE-45: after lease + close handler so inbound cannot race ahead.
        await this.ensureCommsBestEffort(project, accountLabelScope);
        return { ok: true, session, project, agent: "pi" };
    }
    async drainInbound(params) {
        const session = requiredString(params.session, "session");
        const sess = await this.options.storage.getSession(session);
        if (!sess)
            return { messages: [] };
        this.assertCallerProjectMatchesStored(session, sess.project, params);
        const owned = await this.ownedAccountKeys(session);
        const commFilter = typeof params.comm === "string" && params.comm.length > 0 ? params.comm : null;
        const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0
            ? params.limit
            : null;
        const drained = [];
        for (const entry of this.options.pendingInbound) {
            if (!owned.has(accountKey(entry)))
                continue;
            if (commFilter && entry.message.chat.comm !== commFilter)
                continue;
            drained.push(entry);
            if (limit !== null && drained.length >= limit)
                break;
        }
        if (drained.length > 0) {
            await removePendingInboundEntries(this.options.storage, this.options.pendingInbound, drained);
            await this.options.storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id);
        }
        return { messages: drained };
    }
    async unregisterSession(params) {
        const session = requiredString(params.session, "session");
        const connectionId = requiredString(params.connection_id, "connection_id");
        const sess = await this.options.storage.getSession(session);
        if (!sess)
            return { ok: true };
        this.assertCallerProjectMatchesStored(session, sess.project, params);
        await this.options.storage.releaseSessionLease(session, connectionId, Date.now());
        return { ok: true };
    }
}
function accountKey(entry) {
    return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
function requiredString(paramsValue, name) {
    if (typeof paramsValue !== "string" || paramsValue.length === 0) {
        throw new Error(`${name} is required`);
    }
    return paramsValue;
}
function sessionLeaseOwnerFromParams(params) {
    const host = params.host && typeof params.host === "object" && !Array.isArray(params.host)
        ? params.host
        : null;
    const pid = numberParam(host?.pid ?? params.owner_process_pid);
    if (!pid)
        return undefined;
    const label = typeof host?.label === "string"
        ? host.label
        : typeof params.owner_process_label === "string"
            ? params.owner_process_label
            : "pi";
    return {
        process_pid: pid,
        process_label: label,
    };
}
function numberParam(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return null;
    }
    return value;
}
export class PiBridgeFactory {
    agentId = "pi";
    create(context) {
        return new PiBridge({
            storage: context.storage,
            bus: context.bus,
            audit: context.audit,
            pendingInbound: context.pendingInbound,
            ensureCommsForSession: context.ensureCommsForSession,
            daemonOwner: context.daemonOwner,
            sessionOwnerIsLive: context.sessionOwnerIsLive,
        });
    }
}
//# sourceMappingURL=bridge.js.map
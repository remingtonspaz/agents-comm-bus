/**
 * PiBridge — Pi-side of the agents-comm-bus daemon.
 *
 * Hosts the `pi_*` IPC methods, Pi-scoped inbound draining, and explicit lease
 * release. Pi has no wake watcher (the extension polls + injects itself), so
 * this bridge is simpler than Claude/Codex.
 */

import {
  SCHEMA_VERSION_SESSION,
  type AgentId,
  type AuditStore,
  type CommAdapter,
  type SessionId,
  type Storage,
} from "agents-comm-bus-core";

import type { MessageBus } from "../../bus.js";
import type {
  AgentBridge,
  AgentBridgeContext,
  AgentBridgeFactory,
  DaemonSelfIdentity,
  EnsureCommsForSession,
} from "../../runtime/agent-bridge.js";
import { sessionLeaseOwnerWithDaemon } from "../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../runtime/pending-inbound.js";
import { normalizeProjectPath } from "../../project-path.js";
import {
  accountLabelScopeFromParams,
  filterRegistrationsForSession,
} from "../../session-label-scope.js";
import { removePendingInboundEntries } from "../../runtime/durable-inbound.js";
import { sessionEndObservation } from "../../runtime/session-end-sweep.js";
import {
  createSessionOwnerLiveness,
  type SessionOwnerLiveness,
} from "../../runtime/session-owner-liveness.js";

export interface PiBridgeOptions {
  storage: Storage;
  bus: MessageBus;
  audit?: AuditStore;
  pendingInbound: PendingInboundEntry[];
  ensureCommsForSession?: EnsureCommsForSession;
  /** AGE-58: daemon-resolved identity for session ownership stamping. */
  daemonOwner?: DaemonSelfIdentity;
  /** AGE-81: injectable durable-owner liveness for scoped sibling precedence. */
  sessionOwnerIsLive?: SessionOwnerLiveness;
  requestScopeReconcile?: () => void;
}

export interface RegisterPiSessionResult {
  ok: boolean;
  reason?: string;
  session?: SessionId;
  project?: string;
  agent?: AgentId;
}

const PI_IPC_METHODS = new Set<string>([
  "pi_register_session",
  "pi_drain_inbound",
  "pi_unregister_session",
]);

export class PiBridge implements AgentBridge {
  readonly agentId = "pi" as AgentId;
  readonly ipcMethods: ReadonlySet<string> = PI_IPC_METHODS;
  private readonly sessionOwnerIsLive: SessionOwnerLiveness;

  constructor(private readonly options: PiBridgeOptions) {
    this.sessionOwnerIsLive =
      options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
  }

  attach(_comms: CommAdapter[]): void {
    // Pi wires no resolve-sink and no onCallback yet (Phase 1).
  }

  async handleIpcMethod(
    method: string,
    params: Record<string, unknown>,
    ctx: { socket?: { once(event: "close", handler: () => void): void } },
  ): Promise<unknown> {
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

  private async ensureCommsBestEffort(
    project: string,
    accountLabelScope?: string | null,
  ): Promise<void> {
    try {
      await this.options.ensureCommsForSession?.(project, this.agentId, {
        accountLabelScope: accountLabelScope ?? null,
      });
    } catch (error) {
      console.error(
        `agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ownedAccountKeys(session?: SessionId): Promise<Set<string>> {
    if (session) {
      const sess = await this.options.storage.getSession(session);
      if (!sess) return new Set<string>();
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
      const scoped = filterRegistrationsForSession(
        registrations,
        sess,
        sessions,
        this.sessionOwnerIsLive,
      );
      return new Set(scoped.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
    }
    const registrations = await this.options.storage.listAccountRegistrations({
      agent: this.agentId,
    });
    return new Set(registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
  }

  private assertCallerProjectMatchesStored(
    session: SessionId,
    storedProject: string,
    params: Record<string, unknown>,
  ): void {
    if (typeof params.project !== "string" || params.project.length === 0) return;
    const callerProject = normalizeProjectPath(params.project);
    if (callerProject !== storedProject) {
      throw new Error(
        `project mismatch for session ${session}: caller ${callerProject} != stored ${storedProject}`,
      );
    }
  }

  async registerSession(
    params: Record<string, unknown>,
    socket?: { once(event: "close", handler: () => void): void },
  ): Promise<RegisterPiSessionResult> {
    const session = requiredString(params.session, "session") as SessionId;
    const project = normalizeProjectPath(requiredString(params.project, "project"));
    const connectionId = requiredString(params.connection_id, "connection_id");
    const now = Date.now();
    const accountLabelScope = accountLabelScopeFromParams(params);
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: "pi" as AgentId,
      project,
      created_at: now,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
      lease_owner_process_start_time: null,
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
      ? await sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params), this.options.daemonOwner)
      : sessionLeaseOwnerFromParams(params);
    const acquired = await this.options.storage.acquireSessionLease(
      session,
      connectionId,
      now,
      leaseOwner,
    );
    if (!acquired) {
      await this.ensureCommsBestEffort(project, accountLabelScope);
      return { ok: false, reason: "pi session lease already held" };
    }
    socket?.once("close", () => {
      void this.options.storage.releaseSessionConnectionLeasePreservingOwner(
        session,
        connectionId,
        Date.now(),
      );
    });
    // AGE-38/AGE-45: after lease + close handler so inbound cannot race ahead.
    await this.ensureCommsBestEffort(project, accountLabelScope);
    return { ok: true, session, project, agent: "pi" as AgentId };
  }

  /**
   * AGE-91: Pi is route-ready by construction once a session is registered.
   *
   * This is NOT a stub. Pi has no wake route and no `onInboundConversation`
   * because its delivery is **pull-based**: the extension polls
   * `pi_drain_inbound` with its own session id, so the drain IS the delivery.
   * There is no daemon-local route object to check, and reporting `false`
   * would wrongly tell a caller that a live, polling Pi session cannot be
   * reached. Do not "fix" this by inventing a route check.
   */
  routeReady(_session: SessionId): boolean {
    return true;
  }

  async drainInbound(
    params: Record<string, unknown>,
  ): Promise<{ messages: PendingInboundEntry[] }> {
    const session = requiredString(params.session, "session") as SessionId;
    const sess = await this.options.storage.getSession(session);
    if (!sess) return { messages: [] };
    this.assertCallerProjectMatchesStored(session, sess.project, params);

    const owned = await this.ownedAccountKeys(session);
    const commFilter =
      typeof params.comm === "string" && params.comm.length > 0 ? params.comm : null;
    const limit =
      typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0
        ? params.limit
        : null;

    const drained: PendingInboundEntry[] = [];
    for (const entry of this.options.pendingInbound) {
      if (!owned.has(accountKey(entry))) continue;
      if (commFilter && entry.message.chat.comm !== commFilter) continue;
      drained.push(entry);
      if (limit !== null && drained.length >= limit) break;
    }

    if (drained.length > 0) {
      await removePendingInboundEntries(
        this.options.storage,
        this.options.pendingInbound,
        drained,
      );
      await this.options.storage.setSessionMostRecentInbound(
        session,
        drained[drained.length - 1].conversation.conversation_id,
      );
    }
    return { messages: drained };
  }

  async unregisterSession(params: Record<string, unknown>): Promise<{ ok: true }> {
    const session = requiredString(params.session, "session") as SessionId;
    const connectionId = requiredString(params.connection_id, "connection_id");
    const sess = await this.options.storage.getSession(session);
    if (!sess) return { ok: true };
    this.assertCallerProjectMatchesStored(session, sess.project, params);
    if (
      sess.lease_holder_connection_id != null &&
      sess.lease_holder_connection_id !== connectionId
    ) {
      return { ok: true };
    }
    // Terminal Pi unregister — CAS end preserves owner stamps for forensics.
    await this.options.storage.endSessionIfUnchanged(
      session,
      sessionEndObservation(sess),
      Date.now(),
    );
    this.options.requestScopeReconcile?.();
    return { ok: true };
  }
}

function accountKey(entry: PendingInboundEntry): string {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}

function requiredString(paramsValue: unknown, name: string): string {
  if (typeof paramsValue !== "string" || paramsValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return paramsValue;
}

function sessionLeaseOwnerFromParams(params: Record<string, unknown>): {
  process_pid: number | null;
  process_label?: string | null;
  process_start_time?: number | null;
} | undefined {
  const host =
    params.host && typeof params.host === "object" && !Array.isArray(params.host)
      ? (params.host as Record<string, unknown>)
      : null;
  const pid = numberParam(host?.pid ?? params.owner_process_pid);
  if (!pid) return undefined;
  const startTime = numberParam(host?.start_time ?? params.owner_process_start_time);
  const label =
    typeof host?.label === "string"
      ? host.label
      : typeof params.owner_process_label === "string"
        ? params.owner_process_label
        : "pi";
  return {
    process_pid: pid,
    process_label: label,
    process_start_time: startTime,
  };
}

function numberParam(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

export class PiBridgeFactory implements AgentBridgeFactory {
  readonly agentId = "pi" as AgentId;
  create(context: AgentBridgeContext): AgentBridge {
    return new PiBridge({
      storage: context.storage,
      bus: context.bus,
      audit: context.audit,
      pendingInbound: context.pendingInbound,
      ensureCommsForSession: context.ensureCommsForSession,
      daemonOwner: context.daemonOwner,
      sessionOwnerIsLive: context.sessionOwnerIsLive,
      requestScopeReconcile: context.requestScopeReconcile,
    });
  }
}

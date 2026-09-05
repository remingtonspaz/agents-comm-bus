import crypto from "node:crypto";

import {
  SCHEMA_VERSION_SESSION,
  type AccountId,
  type AgentId,
  type AuditStore,
  type CallbackEvent,
  type ChatRef,
  type CommAdapter,
  type CommId,
  type Conversation,
  type InlineKeyboardButton,
  type Query,
  type QueryId,
  type ResolvedDecision,
  type SessionId,
  type Storage,
} from "agents-comm-bus-core";

import { normalizeProjectPath } from "../../project-path.js";
import {
  accountLabelScopeFromParams,
  filterRegistrationsForSession,
  resolveSessionForConversation,
  sessionOwnsConversation,
} from "../../session-label-scope.js";
import { isSessionLocallyDeliverable } from "../../runtime/session-deliverability.js";
import { removePendingInboundEntries } from "../../runtime/durable-inbound.js";
import type { MessageBus } from "../../bus.js";
import type {
  AgentBridge,
  AgentBridgeContext,
  AgentBridgeFactory,
  DaemonSelfIdentity,
  EnsureCommsForSession,
  PersistHeldCommLeaseAgentProperties,
  ReadHeldCommLease,
  RetirementBlockerSnapshot,
} from "../../runtime/agent-bridge.js";
import { sessionLeaseOwnerWithDaemon } from "../../runtime/agent-bridge.js";
import type { AgentLeaseProperties } from "../../runtime/comm-lease.js";
import type { PendingInboundEntry } from "../../runtime/pending-inbound.js";
import {
  CodexAgentAdapter,
  type CodexAgentAdapterOptions,
  codexDecisionFromResolution,
  codexHookDecision,
  isCodexWakeTargetValidationFailure,
} from "./adapter.js";
import {
  WebSocketCodexAppServerClient,
  type CodexAppServerClient,
} from "./app-server.js";
import { cleanupManagedCodexAppServer } from "./app-server-lifecycle.js";
import { probeCodexWakeTargetByCwd, type CodexWakeTargetProbeResult } from "./wake-target-probe.js";
import { sessionEndObservation } from "../../runtime/session-end-sweep.js";
import {
  createSessionOwnerLiveness,
  type SessionOwnerLiveness,
} from "../../runtime/session-owner-liveness.js";

export interface CodexBridgeOptions {
  storage: Storage;
  bus: MessageBus;
  audit?: AuditStore;
  pendingInbound: PendingInboundEntry[];
  defaultAppServerUrl?: string;
  appServerClientFactory?: CodexAgentAdapterOptions["appServerClientFactory"];
  queryPollTimeoutMs?: number;
  appServerCleanupDelayMs?: number;
  sessionOwnerCheckIntervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * AGE-38: lazy, session-triggered comm-adapter instantiation on register.
   * Optional so tests can construct the bridge directly; the daemon's
   * composition root always supplies it.
   */
  ensureCommsForSession?: EnsureCommsForSession;
  /** AGE-58: daemon-resolved identity for session ownership stamping. */
  daemonOwner?: DaemonSelfIdentity;
  /** Injectable timers for deterministic tests (AGE-36 managed cleanup). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** AGE-81: injectable durable-owner liveness for scoped sibling precedence. */
  sessionOwnerIsLive?: SessionOwnerLiveness;
  /** AGE-100: on-disk comm-lock lookup for inbound wake target resolution. */
  readHeldCommLease?: ReadHeldCommLease;
  /** AGE-103: persist discovered wake targets onto a self-held comm lock. */
  persistHeldCommLeaseAgentProperties?: PersistHeldCommLeaseAgentProperties;
  /** AGE-103: loopback port scan range for cwd-probe fallback (default 4500..4600). */
  codexPortRange?: { min: number; max: number };
  codexProbeTimeoutMs?: number;
  codexProbeConcurrency?: number;
  requestScopeReconcile?: () => void;
}

export interface RegisterCodexSessionResult {
  ok: boolean;
  reason?: string;
  capabilities?: CodexAgentAdapter["capabilities"];
}

export interface CodexOpenQueryResult {
  query_id: QueryId;
  hook_response: unknown;
  hookJson: unknown;
  nativeHookJson: unknown;
}

export interface CodexBootstrapStatusResult {
  ok: true;
  has_account_registration: boolean;
  registration_count: number;
  managed_app_server_present: boolean;
  bootstrap_required: boolean;
  reason: string;
}

interface CodexSessionLease {
  session: SessionId;
  project: string;
  connectionId: string;
  manageAppServerLifecycle: boolean;
  control: BridgeControlChannel;
  released: boolean;
}

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_CODEX_PROBE_PORT_MIN = 4500;
const DEFAULT_CODEX_PROBE_PORT_MAX = 4600;
const DEFAULT_CODEX_PROBE_TIMEOUT_MS = 300;
const DEFAULT_CODEX_PROBE_CONCURRENCY = 10;
const DEFAULT_QUERY_POLL_TIMEOUT_MS = 9 * 60 * 1000;
const DEFAULT_APP_SERVER_CLEANUP_DELAY_MS = 3_000;
const DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS = 10_000;
type CodexWakeAuditKind =
  | "agent_wake_attempt"
  | "agent_wake_succeeded"
  | "agent_wake_failed"
  | "agent_wake_skipped"
  | "agent_wake_target_invalid";

const CODEX_IPC_METHODS = new Set<string>([
  "codex_bootstrap_status",
  "codex_register_session",
  "codex_drain_inbound",
  "codex_open_query",
  "codex_turn_control",
]);

export class CodexBridge implements AgentBridge {
  readonly agentId = "codex" as AgentId;
  readonly ipcMethods: ReadonlySet<string> = CODEX_IPC_METHODS;

  private readonly adapter: CodexAgentAdapter;
  private readonly waiters = new Map<QueryId, (decision: ResolvedDecision) => void>();
  private readonly sessionRoutes = new Map<
    SessionId,
    { project: string; account_label_scope: string | null }
  >();
  private readonly activeLeases = new Map<SessionId, CodexSessionLease>();
  private ownedAccountsCache: Set<string> | null = null;
  private ownerCheckTimer: NodeJS.Timeout | null = null;
  /** AGE-36: scheduled / in-flight managed app-server cleanup counters. */
  private pendingManagedCleanups = 0;
  private inFlightManagedCleanups = 0;
  private readonly sessionOwnerIsLive: SessionOwnerLiveness;
  private readonly appServerClientFactory: (url: string) => CodexAppServerClient;
  /** AGE-103: single-flight cwd probe keyed by comm+bot+project. */
  private readonly inFlightCwdProbes = new Map<string, Promise<CodexWakeTargetProbeResult>>();
  private readonly cwdProbeJoiners = new Map<string, number>();

  constructor(private readonly options: CodexBridgeOptions) {
    this.sessionOwnerIsLive =
      options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
    this.appServerClientFactory =
      options.appServerClientFactory ?? ((url) => new WebSocketCodexAppServerClient(url));
    this.adapter = new CodexAgentAdapter({
      defaultAppServerUrl: options.defaultAppServerUrl ?? process.env.CODEX_APP_SERVER_URL,
      appServerClientFactory: this.appServerClientFactory,
    });
  }

  attach(comms: CommAdapter[]): void {
    this.options.bus.setResolveSink({
      onResolved: async (query, decision) => {
        if (query.agent !== this.agentId) return;
        this.waiters.get(query.query_id)?.(decision);
      },
    });

    for (const comm of comms) {
      this.attachComm(comm);
    }
  }

  attachComm(comm: CommAdapter): void {
    if (typeof comm.onCallback === "function") {
      comm.onCallback(async (event) => {
        await this.handleCommCallback(comm, event);
      });
    }
  }

  detachComm(_commId: CommId, _accountId: AccountId): void {
    // CodexBridge keeps no per-adapter state.
  }

  invalidateRegistrationCaches(): void {
    this.ownedAccountsCache = null;
  }

  getRetirementBlockers(): RetirementBlockerSnapshot | null {
    const blockers: Record<string, number> = {};
    const managedLifecycle = [...this.activeLeases.values()].some(
      (lease) => !lease.released && lease.manageAppServerLifecycle,
    );
    if (this.waiters.size > 0) blockers.open_queries = this.waiters.size;
    if (managedLifecycle) blockers.managed_lifecycle = 1;
    if (this.pendingManagedCleanups > 0 || this.inFlightManagedCleanups > 0) {
      blockers.pending_managed_cleanup = 1;
    }
    return Object.keys(blockers).length > 0 ? blockers : null;
  }

  async onInboundConversation(conversation: Conversation): Promise<void> {
    if (conversation.agent !== this.agentId) return;
    const session = await this.resolveSessionForConversation(conversation);
    if (!session) {
      await this.auditWake("agent_wake_skipped", conversation, undefined, {
        reason: "no_codex_session_for_project",
      });
      return;
    }
    const pendingForSession = await this.pendingInboundForConversation(
      conversation,
      session,
    );
    const mostRecentConversationId =
      pendingForSession.at(-1)?.conversation.conversation_id ?? conversation.conversation_id;
    await this.options.storage.setSessionMostRecentInbound(session, mostRecentConversationId);

    const wakeTarget = await this.resolveInboundWakeTargetFromCommLock(conversation);
    if (!wakeTarget.ok) {
      if (wakeTarget.reason === "comm_lease_missing_codex_target") {
        await this.tryProbeFallbackWake(
          conversation,
          session,
          pendingForSession,
          normalizeProjectPath(conversation.project),
        );
        return;
      }
      await this.auditInboundWakeTargetFailure(
        conversation,
        session,
        wakeTarget.reason,
        pendingForSession.length,
      );
      return;
    }

    await this.wakeWithResolvedTarget(
      conversation,
      session,
      pendingForSession,
      wakeTarget.project,
      wakeTarget.appServerUrl,
      wakeTarget.threadId,
      "comm_lease",
    );
  }

  private async wakeWithResolvedTarget(
    conversation: Conversation,
    session: SessionId,
    pendingForSession: PendingInboundEntry[],
    project: string,
    appServerUrl: string,
    threadId: string,
    wakeTargetSource: "comm_lease" | "cwd_probe",
    probeDetail: Record<string, unknown> = {},
  ): Promise<void> {
    this.applyRegistrationTargets(session, project, appServerUrl, threadId);
    await this.auditWake("agent_wake_attempt", conversation, session, {
      app_server_url: appServerUrl,
      thread_id: threadId,
      wake_target_source: wakeTargetSource,
      pending_count: pendingForSession.length,
      pending_message_ids: pendingForSession.map((entry) => entry.message.message_id),
      pending_conversation_ids: [...new Set(pendingForSession.map((entry) => entry.conversation.conversation_id))],
      ...probeDetail,
    });
    try {
      const result = await this.adapter.wakeOrSteer(
        session,
        formatInboundMessagesForTurn(pendingForSession),
      );
      if (result.ok) {
        await this.auditWake("agent_wake_succeeded", conversation, session, {
          app_server_url: appServerUrl,
          method: result.method,
          thread_id: result.threadId,
          fallback_reason: result.fallbackFrom?.reason,
          fallback_error: result.fallbackFrom?.error,
          fallback_thread_id: result.fallbackFrom?.threadId,
          pending_count: pendingForSession.length,
          removed_pending_count: pendingForSession.length,
        });
        await this.removePendingInbound(session, pendingForSession);
        return;
      }
      if (isCodexWakeTargetValidationFailure(result.reason)) {
        if (wakeTargetSource === "cwd_probe") {
          await this.auditProbeTargetValidationFailure(
            conversation,
            session,
            result.reason,
            pendingForSession.length,
          );
          return;
        }
        await this.tryProbeFallbackWake(
          conversation,
          session,
          pendingForSession,
          project,
        );
        return;
      }
      await this.auditWakeFailure(conversation, session, result, pendingForSession.length);
    } catch (error) {
      await this.auditWake("agent_wake_failed", conversation, session, {
        app_server_url: appServerUrl,
        pending_count: pendingForSession.length,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async tryProbeFallbackWake(
    conversation: Conversation,
    session: SessionId,
    pendingForSession: PendingInboundEntry[],
    project: string,
  ): Promise<void> {
    if (!conversation.bot_user_id) {
      await this.auditInboundWakeTargetFailure(
        conversation,
        session,
        "missing_bot_user_id",
        pendingForSession.length,
      );
      return;
    }

    const probe = await this.joinCwdProbe(
      `${conversation.comm}:${conversation.bot_user_id}:${project}`,
      project,
    );
    if (!probe.ok) {
      const detail = {
        reason: probe.reason,
        repair_required: true,
        pending_count: pendingForSession.length,
        probe_scanned: probe.scanned,
        probe_matches: probe.matches,
        probe_ports: probe.ports,
        comm: conversation.comm,
        bot_user_id: conversation.bot_user_id,
      };
      await this.auditWake("agent_wake_failed", conversation, session, detail);
      await this.auditWake("agent_wake_target_invalid", conversation, session, detail);
      console.error(
        `agents-comm-bus: inbound Codex cwd probe failed for ${conversation.conversation_id}: ${probe.reason}`,
      );
      return;
    }

    const persist = this.options.persistHeldCommLeaseAgentProperties;
    if (!persist) {
      await this.auditProbePersistFailure(
        conversation,
        session,
        pendingForSession.length,
        "unavailable",
      );
      return;
    }

    const leaseProps = codexAgentLeaseProperties(probe.appServerUrl, probe.threadId);
    if (!leaseProps) {
      await this.auditProbePersistFailure(
        conversation,
        session,
        pendingForSession.length,
        "invalid-probe-result",
      );
      return;
    }

    const persisted = await persist(conversation.comm, conversation.bot_user_id, leaseProps);
    if (!persisted.ok) {
      await this.auditProbePersistFailure(
        conversation,
        session,
        pendingForSession.length,
        persisted.reason,
      );
      return;
    }

    const probePort = Number(new URL(probe.appServerUrl).port);
    await this.wakeWithResolvedTarget(
      conversation,
      session,
      pendingForSession,
      project,
      probe.appServerUrl,
      probe.threadId,
      "cwd_probe",
      {
        probe_scanned: probe.scanned,
        probe_port: probePort,
      },
    );
  }

  private joinCwdProbe(
    key: string,
    project: string,
  ): Promise<CodexWakeTargetProbeResult> {
    let probe = this.inFlightCwdProbes.get(key);
    if (!probe) {
      const portRange = this.options.codexPortRange ?? {
        min: DEFAULT_CODEX_PROBE_PORT_MIN,
        max: DEFAULT_CODEX_PROBE_PORT_MAX,
      };
      probe = probeCodexWakeTargetByCwd({
        project,
        portRange,
        clientFactory: this.appServerClientFactory,
        perProbeTimeoutMs: this.options.codexProbeTimeoutMs ?? DEFAULT_CODEX_PROBE_TIMEOUT_MS,
        concurrency: this.options.codexProbeConcurrency ?? DEFAULT_CODEX_PROBE_CONCURRENCY,
      });
      this.inFlightCwdProbes.set(key, probe);
      this.cwdProbeJoiners.set(key, 0);
      void probe.finally(() => {
        queueMicrotask(() => {
          if ((this.cwdProbeJoiners.get(key) ?? 0) > 0) return;
          if (this.inFlightCwdProbes.get(key) === probe) {
            this.inFlightCwdProbes.delete(key);
            this.cwdProbeJoiners.delete(key);
          }
        });
      });
    }

    this.cwdProbeJoiners.set(key, (this.cwdProbeJoiners.get(key) ?? 0) + 1);
    return probe.finally(() => {
      const remaining = (this.cwdProbeJoiners.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.cwdProbeJoiners.delete(key);
        queueMicrotask(() => {
          if ((this.cwdProbeJoiners.get(key) ?? 0) === 0) {
            if (this.inFlightCwdProbes.get(key) === probe) {
              this.inFlightCwdProbes.delete(key);
            }
          }
        });
      } else {
        this.cwdProbeJoiners.set(key, remaining);
      }
    });
  }

  private async auditProbePersistFailure(
    conversation: Conversation,
    session: SessionId,
    pendingCount: number,
    reason: string,
  ): Promise<void> {
    const detail = {
      reason: `probe_persist_failed:${reason}`,
      repair_required: true,
      pending_count: pendingCount,
      comm: conversation.comm,
      bot_user_id: conversation.bot_user_id ?? undefined,
    };
    await this.auditWake("agent_wake_failed", conversation, session, detail);
    await this.auditWake("agent_wake_target_invalid", conversation, session, detail);
    console.error(
      `agents-comm-bus: inbound Codex probe persist failed for ${conversation.conversation_id}: ${reason}`,
    );
  }

  private async auditProbeTargetValidationFailure(
    conversation: Conversation,
    session: SessionId,
    reason: string,
    pendingCount: number,
  ): Promise<void> {
    const detail = {
      reason: `probe_target_validation_failed:${reason}`,
      repair_required: true,
      pending_count: pendingCount,
      comm: conversation.comm,
      bot_user_id: conversation.bot_user_id ?? undefined,
    };
    await this.auditWake("agent_wake_failed", conversation, session, detail);
    await this.auditWake("agent_wake_target_invalid", conversation, session, detail);
    console.error(
      `agents-comm-bus: inbound Codex probe target failed validation for ${conversation.conversation_id}: ${reason}`,
    );
  }

  async handleIpcMethod(
    method: string,
    params: Record<string, unknown>,
    ctx: { socket?: { once(event: "close", handler: () => void): void } },
  ): Promise<unknown> {
    switch (method) {
      case "codex_bootstrap_status":
        return this.bootstrapStatus(params);
      case "codex_register_session":
        return this.registerSession(params, ctx.socket);
      case "codex_drain_inbound":
        return this.drainInbound(params);
      case "codex_open_query":
        return this.openQuery(params);
      case "codex_turn_control":
        return this.turnControl(params);
      default:
        throw new Error(`CodexBridge does not handle IPC method: ${method}`);
    }
  }

  async bootstrapStatus(params: Record<string, unknown>): Promise<CodexBootstrapStatusResult> {
    const project = normalizeProjectPath(requiredString(params.project, "project"));
    const accountLabelScope = accountLabelScopeFromParams(params);
    const [registrations, sessions] = await Promise.all([
      this.options.storage.listAccountRegistrations({
        project,
        agent: this.agentId,
      }),
      this.options.storage.listSessions({
        project,
        agent: this.agentId,
        status: "active",
      }),
    ]);
    const scopedRegistrations = filterRegistrationsForSession(
      registrations,
      {
        // SessionStart runs before registration and may not have a managed
        // session id yet. Use a non-persisted identity so every live session
        // remains a sibling candidate for precedence.
        session_id: "__codex_bootstrap_status__" as SessionId,
        project,
        agent: this.agentId,
        account_label_scope: accountLabelScope,
        status: "active",
        lease_holder_connection_id: null,
        lease_owner_process_pid: null,
        lease_owner_process_registered_at: null,
        lease_owner_process_start_time: null,
      },
      sessions,
      this.sessionOwnerIsLive,
    );
    const hasAppServerUrl =
      typeof params.app_server_url === "string" &&
      params.app_server_url.trim().length > 0;
    const hasManagedSession =
      typeof params.managed_session_id === "string" &&
      params.managed_session_id.trim().length > 0;
    const managedAppServerPresent =
      hasAppServerUrl &&
      hasManagedSession &&
      params.app_server_reachable === true;
    const hasAccountRegistration = scopedRegistrations.length > 0;
    const bootstrapRequired = hasAccountRegistration && !managedAppServerPresent;

    return {
      ok: true,
      has_account_registration: hasAccountRegistration,
      registration_count: scopedRegistrations.length,
      managed_app_server_present: managedAppServerPresent,
      bootstrap_required: bootstrapRequired,
      reason: !hasAccountRegistration
        ? "no codex comm account registration for project"
        : managedAppServerPresent
          ? "codex session already has a reachable managed app-server url"
          : "codex comm account registration exists but no managed app-server url is present",
    };
  }

  async registerSession(
    params: Record<string, unknown>,
    socket?: { once(event: "close", handler: () => void): void },
  ): Promise<RegisterCodexSessionResult> {
    const session = requiredString(params.session, "session") as SessionId;
    const project = normalizeProjectPath(requiredString(params.project, "project"));
    const connectionId = typeof params.connection_id === "string"
      ? params.connection_id
      : `codex:${session}:${crypto.randomUUID()}`;
    const now = Date.now();
    const accountLabelScope = accountLabelScopeFromParams(params);
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: this.agentId,
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
    const baselineSession = await this.options.storage.getSession(session);
    const deliverabilityBaseline = baselineSession
      ? this.isLocallyDeliverable(baselineSession)
      : false;
    const replaceExistingLease =
      params.replace_existing_lease === true ||
      params.persist_after_disconnect === true;
    const leaseOwner = this.options.daemonOwner
      ? sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params, "codex"), this.options.daemonOwner)
      : sessionLeaseOwnerFromParams(params, "codex");
    let acquired = await this.options.storage.acquireSessionLease(
      session,
      connectionId,
      now,
      leaseOwner,
    );
    if (!acquired) {
      const releasedDeadLease = await this.releaseDeadSameProjectLease(project, now);
      if (releasedDeadLease) {
        acquired = await this.options.storage.acquireSessionLease(
          session,
          connectionId,
          now,
          leaseOwner,
        );
      }
    }
    const appServerUrl = typeof params.app_server_url === "string"
      ? params.app_server_url
      : undefined;
    const threadId = threadIdFromRegisterParams(params);
    const agentLeaseProperties = this.applyRegistrationTargets(
      session,
      project,
      appServerUrl,
      threadId,
    );

    if (!acquired) {
      const existing = await this.options.storage.getSession(session);
      if (existing?.lease_holder_connection_id && replaceExistingLease) {
        await this.options.storage.releaseSessionLease(
          session,
          existing.lease_holder_connection_id,
          now,
        );
        const reacquired = await this.options.storage.acquireSessionLease(
          session,
          connectionId,
          now,
          leaseOwner,
        );
        if (!reacquired) {
          await this.ensureCommsBestEffort(project, accountLabelScope, agentLeaseProperties);
          return { ok: false, reason: "same-project codex session lease already held" };
        }
      } else if (existing?.lease_holder_connection_id) {
        await this.ensureCommsBestEffort(project, accountLabelScope, agentLeaseProperties);
        return {
          ok: true,
          reason: "codex session lease already held; registration refreshed",
          capabilities: this.adapter.capabilities,
        };
      } else {
        await this.ensureCommsBestEffort(project, accountLabelScope, agentLeaseProperties);
        return { ok: false, reason: "same-project codex session lease already held" };
      }
    }

    const control = new BridgeControlChannel();
    await this.adapter.connect(session, control);
    this.applyRegistrationTargets(session, project, appServerUrl, threadId);
    this.trackSession(project, session, accountLabelScope);
    // AGE-38/AGE-45: after connect + trackSession so inbound cannot race ahead of setup.
    const rehydrated = await this.ensureCommsBestEffort(
      project,
      accountLabelScope,
      agentLeaseProperties,
    );
    const afterSession = await this.options.storage.getSession(session);
    const deliverabilityAfter = afterSession
      ? this.isLocallyDeliverable(afterSession)
      : false;
    if (!deliverabilityBaseline && deliverabilityAfter && rehydrated) {
      await this.redrivePendingInbound(session);
    }

    const persistAfterDisconnect = params.persist_after_disconnect === true;
    const manageAppServerLifecycle =
      params.manage_app_server_lifecycle === true ||
      params.source === "mcp-server";
    const lease: CodexSessionLease = {
      session,
      project,
      connectionId,
      manageAppServerLifecycle,
      control,
      released: false,
    };
    this.activeLeases.set(session, lease);
    this.ensureOwnerCheckTimer();
    const release = () => {
      if (persistAfterDisconnect) return;
      void this.releaseSessionLease(lease);
    };
    socket?.once("close", release);

    return { ok: true, capabilities: this.adapter.capabilities };
  }

  async drainInbound(params: Record<string, unknown>): Promise<PendingInboundEntry[]> {
    const session = typeof params.session === "string" ? params.session as SessionId : undefined;
    // The pending-inbound queue is daemon-wide and shared with other
    // bridges (e.g. ClaudeBridge). Drain only entries whose source
    // `(comm, account)` belongs to a Codex registration; otherwise a
    // draining bridge sweeps the queue and starves its siblings. We use
    // `message.chat.account` (the bot_user_id, the source-of-truth field)
    // rather than the derived `conversation.agent`.
    const owned = await this.ownedAccountKeys(session);
    const drained = this.options.pendingInbound.filter((entry) =>
      owned.has(accountKey(entry)),
    );
    if (drained.length > 0) {
      await removePendingInboundEntries(
        this.options.storage,
        this.options.pendingInbound,
        drained,
      );
    }
    if (session && drained.length > 0) {
      await this.options.storage.setSessionMostRecentInbound(
        session,
        drained[drained.length - 1].conversation.conversation_id,
      );
    }
    return drained;
  }

  async openQuery(params: Record<string, unknown>): Promise<CodexOpenQueryResult> {
    const session = requiredString(params.session, "session") as SessionId;
    const queryInput = recordOrEmpty(params.query);
    const promptText = requiredString(
      params.prompt_text ?? queryInput.prompt_text,
      "prompt_text",
    );
    const queryId = `q_${crypto.randomUUID()}` as QueryId;
    const sessionRecord = await this.options.storage.getSession(session);
    const conversation = sessionRecord?.most_recent_inbound_conversation_id
      ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
      : null;
    const originChat = conversation ? await this.chatRefForConversation(conversation) : undefined;
    if (!originChat) {
      const hookResponse = codexHookDecision(
        "deny",
        `No recent inbound comm conversation is associated with Codex session ${session}.`,
      );
      return {
        query_id: queryId,
        hook_response: hookResponse,
        hookJson: hookResponse,
        nativeHookJson: hookResponse,
      };
    }
    const query: Query = {
      schema_version: 1,
      query_id: queryId,
      agent: this.agentId,
      session,
      kind: "approval",
      prompt_text: promptText,
      origin_chat: originChat,
      created_at: Date.now(),
      ttl_seconds:
        typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS,
    };
    // AGE-9: same caller-chosen supersede policy as ClaudeBridge.openQuery.
    const supersede = params.supersede !== false;
    if (supersede) {
      await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
    }
    const resolutionPromise = this.waitForResolution(queryId, query.ttl_seconds);
    try {
      await this.options.bus.openQuery(query);
      const promptFormat = params.prompt_format ?? queryInput.prompt_format;
      const promptMessageId = await this.options.bus.send({
        session,
        comm: originChat.comm,
        target: originChat,
        payload: {
          text: promptText,
          format: promptFormat === "html" ? "html" : "plain",
          inline_keyboard: inlineKeyboardForQuery(queryId),
        },
        idempotencyKey: `query:${queryId}`,
      });
      // AGE-9: activate reply-to targeting for this prompt (best-effort).
      try {
        await this.options.storage.setQuerySourceMessage(queryId, promptMessageId);
      } catch (error) {
        console.error(
          `agents-comm-bus: failed to record prompt message id for ${queryId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const decision = await resolutionPromise;
      const hookResponse = codexDecisionFromResolution(decision);
      return {
        query_id: queryId,
        hook_response: hookResponse,
        hookJson: hookResponse,
        nativeHookJson: hookResponse,
      };
    } catch (error) {
      this.clearWaiter(queryId);
      throw error;
    }
  }

  async turnControl(params: Record<string, unknown>): Promise<unknown> {
    const session = requiredString(params.session, "session") as SessionId;
    const kind = params.kind === "steer" ? "steer" : params.kind === "interrupt" ? "interrupt" : "start";
    const appServerUrl = typeof params.app_server_url === "string" ? params.app_server_url : undefined;
    const threadId = threadIdFromRegisterParams(params);
    const route = this.sessionRoutes.get(session);
    if (route && (appServerUrl || threadId)) {
      this.adapter.setWakeTarget(session, {
        project: route.project,
        appServerUrl,
        threadId,
      });
    }
    if (appServerUrl) {
      this.adapter.setAppServerUrl(session, appServerUrl);
    }
    if (kind === "start") {
      await this.adapter.wake(session);
      return { ok: true, method: "turn/start" };
    }
    if (kind === "steer") {
      await this.adapter.steer(session, params.payload ?? params.text ?? "");
      return { ok: true, method: "turn/steer" };
    }
    await this.adapter.interrupt(session);
    return { ok: true, method: "turn/interrupt" };
  }

  private async handleCommCallback(
    comm: CommAdapter,
    event: CallbackEvent,
  ): Promise<void> {
    const parsed = parseCallbackData(event.data);
    if (!parsed) return;

    const openQuery = await this.options.storage.getOpenQueryById(parsed.queryId as QueryId);
    if (!openQuery || openQuery.agent !== this.agentId) {
      return;
    }

    const chat: ChatRef = {
      comm: comm.id,
      account: "" as ChatRef["account"],
      chat_native_id: event.chat_native_id,
    };

    const outcome = await this.options.bus.resolveQueryFromCallback({
      queryId: parsed.queryId as QueryId,
      value: parsed.value,
      fromId: event.from_id,
      chat,
    });

    if (!comm.answerCallback) return;
    if (outcome.kind === "resolved") {
      await comm.answerCallback(event.callback_id, { text: ackTextFor(outcome.decision) });
      if (comm.editMessage) {
        try {
          await comm.editMessage(
            event.chat_native_id,
            event.message_native_id,
            `Resolved via Telegram (${ackTextFor(outcome.decision)}).`,
          );
        } catch {
          // Best-effort UI update only.
        }
      }
      return;
    }
    if (outcome.kind === "already_resolved") {
      await comm.answerCallback(event.callback_id, { text: "Already resolved." });
      return;
    }
    if (outcome.kind === "invalid_value") {
      await comm.answerCallback(event.callback_id, { text: `Unrecognized value: ${outcome.value}` });
      return;
    }
    await comm.answerCallback(event.callback_id, { text: outcome.kind });
  }

  private waitForResolution(queryId: QueryId, ttlSeconds: number): Promise<ResolvedDecision | null> {
    const timeoutMs = Math.min(
      this.options.queryPollTimeoutMs ?? DEFAULT_QUERY_POLL_TIMEOUT_MS,
      Math.max(1, ttlSeconds) * 1000,
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.clearWaiter(queryId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(queryId, (decision) => {
        clearTimeout(timer);
        this.clearWaiter(queryId);
        resolve(decision);
      });
    });
  }

  private clearWaiter(queryId: QueryId): void {
    this.waiters.delete(queryId);
  }

  private async resolveInboundWakeTargetFromCommLock(
    conversation: Conversation,
  ): Promise<
    | { ok: true; appServerUrl: string; threadId: string; project: string }
    | { ok: false; reason: string }
  > {
    if (!conversation.bot_user_id) {
      return { ok: false, reason: "missing_bot_user_id" };
    }
    const readHeld = this.options.readHeldCommLease;
    if (!readHeld) {
      return { ok: false, reason: "comm_lease_lookup_unavailable" };
    }
    const lookup = await readHeld(conversation.comm, conversation.bot_user_id);
    if (!lookup.ok) {
      return { ok: false, reason: `comm_lease_${lookup.reason}` };
    }
    const codex = lookup.agentProperties?.codex;
    const appServerUrl = codex?.appServerUrl;
    const threadId = codex?.threadId;
    if (typeof appServerUrl !== "string" || appServerUrl.length === 0
      || typeof threadId !== "string" || threadId.length === 0) {
      return { ok: false, reason: "comm_lease_missing_codex_target" };
    }
    return {
      ok: true,
      appServerUrl,
      threadId,
      project: normalizeProjectPath(conversation.project),
    };
  }

  private async auditInboundWakeTargetFailure(
    conversation: Conversation,
    session: SessionId,
    reason: string,
    pendingCount: number,
  ): Promise<void> {
    const detail = {
      reason,
      repair_required: true,
      pending_count: pendingCount,
      comm: conversation.comm,
      bot_user_id: conversation.bot_user_id ?? undefined,
    };
    await this.auditWake("agent_wake_failed", conversation, session, detail);
    await this.auditWake("agent_wake_target_invalid", conversation, session, detail);
    console.error(
      `agents-comm-bus: inbound Codex wake target invalid for ${conversation.conversation_id}: ${reason}`,
    );
  }

  private applyRegistrationTargets(
    session: SessionId,
    project: string,
    appServerUrl: string | undefined,
    threadId: string | undefined,
  ): AgentLeaseProperties | undefined {
    if (appServerUrl || threadId) {
      this.adapter.setWakeTarget(session, {
        project,
        appServerUrl,
        threadId,
      });
    }
    if (appServerUrl) {
      this.adapter.setAppServerUrl(session, appServerUrl);
    }
    return codexAgentLeaseProperties(appServerUrl, threadId);
  }

  private async ensureCommsBestEffort(
    project: string,
    accountLabelScope?: string | null,
    agentLeaseProperties?: AgentLeaseProperties,
  ): Promise<boolean> {
    const hook = this.options.ensureCommsForSession;
    if (!hook) return false;
    try {
      const result = await hook(project, this.agentId, {
        accountLabelScope: accountLabelScope ?? null,
        agentLeaseProperties,
      });
      return result.rehydrated;
    } catch (error) {
      console.error(
        `agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** AGE-91: daemon-local route = a tracked app-server route for this session. */
  routeReady(sessionId: SessionId): boolean {
    return this.sessionRoutes.has(sessionId);
  }

  private isLocallyDeliverable(
    session: Parameters<SessionOwnerLiveness>[0] & { session_id: SessionId },
  ): boolean {
    return isSessionLocallyDeliverable(
      session,
      this.routeReady(session.session_id),
      this.sessionOwnerIsLive,
    );
  }

  /**
   * AGE-90: after a deliverability edge with confirmed rehydration, wake once
   * via the newest in-scope pending row. `pendingInboundForConversation`
   * aggregates every owned-account entry in the project for one steer attempt.
   */
  private async redrivePendingInbound(sessionId: SessionId): Promise<void> {
    const sess = await this.options.storage.getSession(sessionId);
    if (!sess) return;

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
    const scopedRegs = filterRegistrationsForSession(
      registrations,
      sess,
      sessions,
      this.sessionOwnerIsLive,
    );
    const ownedKeys = new Set(
      scopedRegs.map((reg) => `${reg.comm}:${reg.bot_user_id}`),
    );

    const inScope = this.options.pendingInbound.filter((entry) => {
      if (entry.conversation.project !== sess.project) return false;
      if (entry.conversation.agent !== this.agentId) return false;
      if (!ownedKeys.has(accountKey(entry))) return false;
      return sessionOwnsConversation(
        sess,
        sessions,
        entry.conversation,
        this.sessionOwnerIsLive,
      );
    });
    if (inScope.length === 0) return;

    const seed = inScope.reduce((latest, entry) =>
      entry.message.received_at > latest.message.received_at ? entry : latest,
    );
    await this.onInboundConversation(seed.conversation);
  }

  private trackSession(
    project: string,
    session: SessionId,
    accountLabelScope: string | null,
  ): void {
    this.sessionRoutes.set(session, {
      project,
      account_label_scope: accountLabelScope,
    });
  }

  private untrackSession(project: string, session: SessionId): void {
    const route = this.sessionRoutes.get(session);
    if (!route || route.project !== project) return;
    this.sessionRoutes.delete(session);
  }

  private async resolveSessionForConversation(
    conversation: Conversation,
  ): Promise<SessionId | undefined> {
    const project = normalizeProjectPath(conversation.project);
    const inMemory = [...this.sessionRoutes.entries()]
      .filter(([, route]) => route.project === project)
      .map(([sessionId, route]) => ({
        session_id: sessionId,
        project: route.project,
        agent: this.agentId,
        account_label_scope: route.account_label_scope,
      }));
    const fromMemory = resolveSessionForConversation(
      inMemory,
      conversation,
      (sess) => sess.session_id,
    );
    if (fromMemory) return fromMemory.session_id;

    const sessions = await this.options.storage.listSessions({
      project,
      agent: this.agentId,
      status: "active",
    });
    const live = sessions.filter((sess) => sess.lease_holder_connection_id != null);
    const pool = live.length > 0 ? live : sessions;
    const hydrated = resolveSessionForConversation(pool, conversation, (sess) => sess.session_id);
    if (!hydrated) return undefined;
    this.trackSession(project, hydrated.session_id, hydrated.account_label_scope);
    return hydrated.session_id;
  }

  private async releaseSessionLease(input: CodexSessionLease): Promise<void> {
    if (input.released) return;
    input.released = true;
    try {
      this.untrackSession(input.project, input.session);
      const active = this.activeLeases.get(input.session);
      if (active?.connectionId === input.connectionId) {
        this.activeLeases.delete(input.session);
      }
      await this.adapter.disconnect(input.session);
      if (input.manageAppServerLifecycle) {
        // AGE-82: a managed release schedules cleanup, which ends the row.
        // `releaseSessionLease` NULLs every owner/daemon stamp, so ending a
        // row released that way would scrub exactly the forensics the sweep is
        // required to preserve. Keep the stamps until the row is truly ended.
        await this.options.storage.releaseSessionConnectionLeasePreservingOwner(
          input.session,
          input.connectionId,
          Date.now(),
        );
      } else {
        await this.options.storage.releaseSessionLease(input.session, input.connectionId, Date.now());
      }
      input.control.close();
      if (input.manageAppServerLifecycle) {
        this.scheduleManagedAppServerCleanup(input.session);
      }
      this.stopOwnerCheckTimerIfIdle();
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to release Codex session ${input.session}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ensureOwnerCheckTimer(): void {
    if (this.ownerCheckTimer || this.activeLeases.size === 0) return;
    const interval =
      this.options.sessionOwnerCheckIntervalMs ?? DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS;
    this.ownerCheckTimer = setInterval(() => {
      void this.releaseLeasesWithDeadOwners();
    }, interval);
    this.ownerCheckTimer.unref?.();
  }

  private stopOwnerCheckTimerIfIdle(): void {
    if (!this.ownerCheckTimer || this.activeLeases.size > 0) return;
    clearInterval(this.ownerCheckTimer);
    this.ownerCheckTimer = null;
  }

  private async releaseLeasesWithDeadOwners(): Promise<void> {
    for (const lease of [...this.activeLeases.values()]) {
      const record = await this.options.storage.getSession(lease.session);
      if (record?.lease_holder_connection_id !== lease.connectionId) continue;
      const ownerPid = record.lease_owner_process_pid;
      if (!ownerPid) continue;
      const isAlive = this.options.isProcessAlive ?? isPidAlive;
      if (isAlive(ownerPid)) continue;
      await this.releaseSessionLease(lease);
    }
  }

  private async releaseDeadSameProjectLease(project: string, at: number): Promise<boolean> {
    const isAlive = this.options.isProcessAlive ?? isPidAlive;
    const sessions = await this.options.storage.listSessions({
      project,
      agent: this.agentId,
      status: "active",
    });
    let released = false;
    for (const session of sessions) {
      const connectionId = session.lease_holder_connection_id;
      const ownerPid = session.lease_owner_process_pid;
      if (!connectionId || !ownerPid || isAlive(ownerPid)) continue;
      await this.options.storage.releaseSessionLease(session.session_id, connectionId, at);
      released = true;
    }
    return released;
  }

  private scheduleManagedAppServerCleanup(session: SessionId): void {
    const delay = this.options.appServerCleanupDelayMs ?? DEFAULT_APP_SERVER_CLEANUP_DELAY_MS;
    this.pendingManagedCleanups += 1;
    const setTimeoutFn =
      this.options.setTimeoutFn ??
      ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    setTimeoutFn(() => {
      this.pendingManagedCleanups -= 1;
      this.inFlightManagedCleanups += 1;
      void this.cleanupManagedAppServerIfLeaseIsIdle(session).finally(() => {
        this.inFlightManagedCleanups -= 1;
      });
    }, delay);
  }

  private async cleanupManagedAppServerIfLeaseIsIdle(session: SessionId): Promise<void> {
    try {
      const record = await this.options.storage.getSession(session);
      if (record?.lease_holder_connection_id) return;
      const result = await cleanupManagedCodexAppServer(session);
      if (!result.ok) return;
      const latest = await this.options.storage.getSession(session);
      if (!latest || latest.status !== "active" || latest.lease_holder_connection_id) {
        return;
      }
      await this.options.storage.endSessionIfUnchanged(
        session,
        sessionEndObservation(latest),
        Date.now(),
      );
      this.options.requestScopeReconcile?.();
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to cleanup Codex app-server for ${session}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async chatRefForConversation(conversation: Conversation): Promise<ChatRef | undefined> {
    if (conversation.bot_user_id) {
      return {
        comm: conversation.comm,
        account: conversation.bot_user_id as ChatRef["account"],
        chat_native_id: conversation.chat_native_id,
        thread_native_id: conversation.thread_native_id ?? undefined,
      };
    }

    // AGE-22: resolve the owning registration by its stable registration_id
    // (NOT NULL on conversations as of migration 008). No account_label fallback.
    const registrations = await this.options.storage.listAccountRegistrations({
      project: conversation.project,
      comm: conversation.comm,
      agent: conversation.agent,
    });
    const registration = registrations.find(
      (candidate) => candidate.registration_id === conversation.registration_id,
    );
    if (!registration) return undefined;
    return {
      comm: conversation.comm,
      account: registration.bot_user_id as ChatRef["account"],
      chat_native_id: conversation.chat_native_id,
      thread_native_id: conversation.thread_native_id ?? undefined,
    };
  }

  private async auditWake(
    kind: CodexWakeAuditKind,
    conversation: Conversation,
    session: SessionId | undefined,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.options.audit?.append({
        timestamp: Date.now(),
        kind,
        agent: this.agentId,
        session,
        conversation_id: conversation.conversation_id,
        detail: {
          comm: conversation.comm,
          account_label: conversation.account_label,
          chat_native_id: conversation.chat_native_id,
          thread_native_id: conversation.thread_native_id ?? undefined,
          project: conversation.project,
          ...detail,
        },
      });
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to audit Codex wake event for ${conversation.conversation_id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async auditWakeFailure(
    conversation: Conversation,
    session: SessionId,
    result: { ok: false; reason: string; error?: string; threadId?: string },
    pendingCount: number,
  ): Promise<void> {
    const detail = {
      app_server_url: this.adapter.appServerUrlFor(session),
      pending_count: pendingCount,
      reason: result.reason,
      error: result.error,
      thread_id: result.threadId,
      repair_required: isCodexWakeTargetValidationFailure(result.reason),
    };
    await this.auditWake("agent_wake_failed", conversation, session, detail);
    if (isCodexWakeTargetValidationFailure(result.reason)) {
      await this.auditWake("agent_wake_target_invalid", conversation, session, detail);
    }
    console.error(
      `agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ${result.reason}` +
        `${result.error ? `: ${result.error}` : ""}`,
    );
  }

  private async pendingInboundForConversation(
    conversation: Conversation,
    session: SessionId,
  ): Promise<PendingInboundEntry[]> {
    const owned = await this.ownedAccountKeys(session);
    return this.options.pendingInbound.filter((entry) =>
      owned.has(accountKey(entry)) &&
      entry.conversation.project === conversation.project,
    );
  }

  /**
   * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. See
   * the matching comment in `ClaudeBridge` for the caching contract.
   */
  private async ownedAccountKeys(session?: SessionId): Promise<Set<string>> {
    // AGE-38: scope to the calling session's (project, agent), not agent-wide
    // (see ClaudeBridge for the rationale). The wake path
    // (`pendingInboundForConversation`) still calls this with no session and
    // applies its own `conversation.project` filter, so agent-wide is correct
    // there. Unknown session → empty Set (don't bleed). No session → agent-wide
    // (cached).
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
    if (this.ownedAccountsCache) return this.ownedAccountsCache;
    const registrations = await this.options.storage.listAccountRegistrations({
      agent: this.agentId,
    });
    this.ownedAccountsCache = new Set(
      registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`),
    );
    return this.ownedAccountsCache;
  }

  private async removePendingInbound(
    session: SessionId,
    entries: PendingInboundEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    // Scope removal by durable delivery key (message_id + comm + account) so
    // we only remove Codex-owned entries. The same Telegram message can
    // appear in pendingInbound twice when multiple bots in the same chat each
    // receive the update.
    const owned = await this.ownedAccountKeys(session);
    const scoped = entries.filter((entry) => owned.has(accountKey(entry)));
    await removePendingInboundEntries(
      this.options.storage,
      this.options.pendingInbound,
      scoped,
    );
  }
}

function accountKey(entry: PendingInboundEntry): string {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}

function formatInboundMessagesForTurn(entries: PendingInboundEntry[]): string {
  if (entries.length === 0) {
    return "Check for pending daemon-delivered messages and handle them if present.";
  }
  const lines = entries.map((entry) => {
    const message = entry.message;
    const conversation = entry.conversation;
    const sender = message.sender.display_name ?? message.sender.id ?? "unknown sender";
    const textParts = [];
    if (message.text) textParts.push(message.text);
    for (const attachment of message.attachments ?? []) {
      textParts.push(formatAttachmentForCodex(attachment));
    }
    const text = textParts.join(" ").trim() || "[no text]";
    const envelope = [
      `comm=${conversation.comm}`,
      // `account` is the concrete bot_user_id — the routing key to echo back on
      // sends (AGE-15). account_label is human metadata only and must NOT be
      // used as a send target; surfacing the label here previously taught the
      // agent to route by it, which cross-resolved to the other agent's bot.
      `account=${message.chat.account}`,
      `account_label=${conversation.account_label}`,
      `chat_native_id=${conversation.chat_native_id}`,
      conversation.thread_native_id ? `thread_native_id=${conversation.thread_native_id}` : null,
      `conversation_id=${conversation.conversation_id}`,
      message.platform_message_id ? `platform_message_id=${message.platform_message_id}` : null,
      `message_id=${message.message_id}`,
    ].filter(Boolean).join(" ");
    return `[${new Date(message.received_at).toISOString()}] ${sender} (${envelope}): ${text}`;
  });
  return [
    inboundInstructionFor(entries),
    "[Daemon Inbound Messages]",
    ...lines,
    "[End Daemon Inbound Messages]",
  ].join("\n");
}

function inboundInstructionFor(entries: PendingInboundEntry[]): string {
  const comms = [...new Set(entries.map((entry) => entry.conversation.comm))];
  if (comms.length === 1) {
    const commName = displayCommName(comms[0]);
    return `Process these daemon-delivered ${commName} messages as user input. If a reply is requested, use the ${commName} MCP tool.`;
  }
  return "Process these daemon-delivered messages as user input. If a reply is requested, use the MCP tool matching each message's comm value.";
}

function displayCommName(comm: CommId): string {
  switch (comm) {
    case "discord":
      return "Discord";
    case "matrix":
      return "Matrix";
    case "telegram":
      return "Telegram";
    default:
      return String(comm);
  }
}

function formatAttachmentForCodex(attachment: {
  local_path?: string;
  filename?: string;
  mime?: string;
  size?: number;
  blob_hash?: string;
}): string {
  const fields = [
    attachment.local_path ? `path=${JSON.stringify(attachment.local_path)}` : null,
    attachment.filename ? `filename=${JSON.stringify(attachment.filename)}` : null,
    attachment.mime ? `mime=${JSON.stringify(attachment.mime)}` : null,
    typeof attachment.size === "number" ? `size=${attachment.size}` : null,
    attachment.blob_hash ? `blob_hash=${attachment.blob_hash}` : null,
  ].filter(Boolean);
  return `[Attachment: ${fields.join(" ") || "attachment"}]`;
}

function inlineKeyboardForQuery(queryId: QueryId): InlineKeyboardButton[][] {
  return [
    [
      { text: "Allow", callback_data: `q:${queryId}:y` },
      { text: "Deny", callback_data: `q:${queryId}:n` },
    ],
    [{ text: "Always", callback_data: `q:${queryId}:a` }],
  ];
}

function parseCallbackData(data: string): { queryId: string; value: string } | null {
  if (!data.startsWith("q:")) return null;
  const rest = data.slice(2);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const queryId = rest.slice(0, sep);
  const value = rest.slice(sep + 1);
  if (!queryId || !value) return null;
  return { queryId, value };
}

function ackTextFor(decision: ResolvedDecision): string {
  switch (decision.decision) {
    case "allow":
      return "Allowed";
    case "always_allow":
      return "Allowed";
    case "deny":
      return "Denied";
    default:
      return "Recorded";
  }
}

function codexAgentLeaseProperties(
  appServerUrl: string | undefined,
  threadId: string | undefined,
): AgentLeaseProperties | undefined {
  if (!appServerUrl || !threadId) return undefined;
  return {
    codex: {
      appServerUrl,
      threadId,
    },
  };
}

function threadIdFromRegisterParams(params: Record<string, unknown>): string | undefined {
  const direct = params.thread_id ?? params.threadId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const codex = recordOrEmpty(params.codex);
  const fromHook =
    codex.thread_id ??
    codex.threadId ??
    codex.session_id ??
    codex.sessionId;
  return typeof fromHook === "string" && fromHook.length > 0 ? fromHook : undefined;
}

function requiredString(paramsValue: unknown, name: string): string {
  if (typeof paramsValue !== "string" || paramsValue.length === 0) {
    throw new Error(`${name} is required`);
  }
  return paramsValue;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sessionLeaseOwnerFromParams(params: Record<string, unknown>, fallbackLabel: string): {
  process_pid: number | null;
  process_label?: string | null;
  process_start_time?: number | null;
} | undefined {
  const pid = numberParam(params.owner_process_pid);
  if (!pid) return undefined;
  return {
    process_pid: pid,
    process_label: typeof params.owner_process_label === "string"
      ? params.owner_process_label
      : fallbackLabel,
    process_start_time: numberParam(params.owner_process_start_time),
  };
}

function numberParam(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class BridgeControlChannel {
  private closeHandler: (() => void) | null = null;

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async send(_envelope: unknown): Promise<void> {
    // Bridge-local adapter control frames are diagnostic only for now.
  }

  close(): void {
    this.closeHandler?.();
  }
}

export interface CodexBridgeFactoryOptions {
  codexPortRange?: { min: number; max: number };
  codexProbeTimeoutMs?: number;
  codexProbeConcurrency?: number;
}

export class CodexBridgeFactory implements AgentBridgeFactory {
  readonly agentId = "codex" as AgentId;

  constructor(private readonly factoryOptions: CodexBridgeFactoryOptions = {}) {}

  create(context: AgentBridgeContext): AgentBridge {
    return new CodexBridge({
      storage: context.storage,
      bus: context.bus,
      audit: context.audit,
      pendingInbound: context.pendingInbound,
      ensureCommsForSession: context.ensureCommsForSession,
      daemonOwner: context.daemonOwner,
      sessionOwnerIsLive: context.sessionOwnerIsLive,
      readHeldCommLease: context.readHeldCommLease,
      persistHeldCommLeaseAgentProperties: context.persistHeldCommLeaseAgentProperties,
      codexPortRange: this.factoryOptions.codexPortRange,
      codexProbeTimeoutMs: this.factoryOptions.codexProbeTimeoutMs,
      codexProbeConcurrency: this.factoryOptions.codexProbeConcurrency,
      requestScopeReconcile: context.requestScopeReconcile,
    });
  }
}

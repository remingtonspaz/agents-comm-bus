import crypto from "node:crypto";

import {
  SCHEMA_VERSION_SESSION,
  type AgentId,
  type CallbackEvent,
  type ChatRef,
  type CommAdapter,
  type Conversation,
  type InlineKeyboardButton,
  type Query,
  type QueryId,
  type ResolvedDecision,
  type SessionId,
  type Storage,
} from "../../../../../agents-comm-bus-core/dist/index.js";

import type { MessageBus } from "../../../bus.js";
import type {
  AgentBridge,
  AgentBridgeContext,
  AgentBridgeFactory,
} from "../../../runtime/agent-bridge.js";
import type { PendingInboundEntry } from "../../../runtime/pending-inbound.js";
import {
  CodexAgentAdapter,
  codexDecisionFromResolution,
  codexHookDecision,
} from "./adapter.js";
import { cleanupManagedCodexAppServer } from "./app-server-lifecycle.js";

export interface CodexBridgeOptions {
  storage: Storage;
  bus: MessageBus;
  pendingInbound: PendingInboundEntry[];
  defaultAppServerUrl?: string;
  queryPollTimeoutMs?: number;
  appServerCleanupDelayMs?: number;
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

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_QUERY_POLL_TIMEOUT_MS = 9 * 60 * 1000;
const DEFAULT_APP_SERVER_CLEANUP_DELAY_MS = 3_000;

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
  private readonly sessionsByProject = new Map<string, Set<SessionId>>();
  private ownedAccountsCache: Set<string> | null = null;

  constructor(private readonly options: CodexBridgeOptions) {
    this.adapter = new CodexAgentAdapter({
      defaultAppServerUrl: options.defaultAppServerUrl ?? process.env.CODEX_APP_SERVER_URL,
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
      if (typeof comm.onCallback === "function") {
        comm.onCallback(async (event) => {
          await this.handleCommCallback(comm, event);
        });
      }
    }
  }

  async onInboundConversation(conversation: Conversation): Promise<void> {
    if (conversation.agent !== this.agentId) return;
    const sessions = this.sessionsByProject.get(conversation.project);
    const session = sessions?.values().next().value as SessionId | undefined;
    if (!session) {
      return;
    }
    const pendingForSession = await this.pendingInboundForConversation(conversation);
    const mostRecentConversationId =
      pendingForSession.at(-1)?.conversation.conversation_id ?? conversation.conversation_id;
    await this.options.storage.setSessionMostRecentInbound(session, mostRecentConversationId);
    try {
      const result = await this.adapter.wakeOrSteer(
        session,
        formatInboundMessagesForTurn(pendingForSession),
      );
      if (result.ok && result.method === "turn/steer") {
        this.removePendingInbound(pendingForSession);
      }
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    const project = requiredString(params.project, "project");
    const registrations = await this.options.storage.listAccountRegistrations({
      project,
      agent: this.agentId,
    });
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
    const hasAccountRegistration = registrations.length > 0;
    const bootstrapRequired = hasAccountRegistration && !managedAppServerPresent;

    return {
      ok: true,
      has_account_registration: hasAccountRegistration,
      registration_count: registrations.length,
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
    const project = requiredString(params.project, "project");
    const connectionId = typeof params.connection_id === "string"
      ? params.connection_id
      : `codex:${session}:${crypto.randomUUID()}`;
    const now = Date.now();
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: this.agentId,
      project,
      created_at: now,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      most_recent_inbound_conversation_id: null,
      status: "active",
    });
    const replaceExistingLease =
      params.replace_existing_lease === true ||
      params.persist_after_disconnect === true;
    const acquired = await this.options.storage.acquireSessionLease(session, connectionId, now);
    if (!acquired) {
      const existing = await this.options.storage.getSession(session);
      if (existing?.lease_holder_connection_id && replaceExistingLease) {
        await this.options.storage.releaseSessionLease(
          session,
          existing.lease_holder_connection_id,
          now,
        );
        const reacquired = await this.options.storage.acquireSessionLease(session, connectionId, now);
        if (!reacquired) {
          return { ok: false, reason: "same-project codex session lease already held" };
        }
      } else if (existing?.lease_holder_connection_id) {
        return {
          ok: true,
          reason: "codex session lease already held; registration refreshed",
          capabilities: this.adapter.capabilities,
        };
      } else {
        return { ok: false, reason: "same-project codex session lease already held" };
      }
    }

    const control = new BridgeControlChannel();
    await this.adapter.connect(session, control);
    if (typeof params.app_server_url === "string") {
      this.adapter.setAppServerUrl(session, params.app_server_url);
    }
    this.trackSession(project, session);

    const persistAfterDisconnect = params.persist_after_disconnect === true;
    const manageAppServerLifecycle =
      params.manage_app_server_lifecycle === true ||
      params.source === "mcp-server";
    const release = () => {
      if (persistAfterDisconnect) return;
      void this.releaseSessionLease({
        session,
        project,
        connectionId,
        manageAppServerLifecycle,
        control,
      });
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
    const owned = await this.ownedAccountKeys();
    const drained: PendingInboundEntry[] = [];
    for (let i = this.options.pendingInbound.length - 1; i >= 0; i -= 1) {
      const entry = this.options.pendingInbound[i];
      if (owned.has(accountKey(entry))) {
        drained.unshift(entry);
        this.options.pendingInbound.splice(i, 1);
      }
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
        `No recent inbound Telegram conversation is associated with Codex session ${session}.`,
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
    await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
    const resolutionPromise = this.waitForResolution(queryId, query.ttl_seconds);
    await this.options.bus.openQuery(query);
    const promptFormat = params.prompt_format ?? queryInput.prompt_format;
    await this.options.bus.send({
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

    const decision = await resolutionPromise;
    const hookResponse = codexDecisionFromResolution(decision);
    return {
      query_id: queryId,
      hook_response: hookResponse,
      hookJson: hookResponse,
      nativeHookJson: hookResponse,
    };
  }

  async turnControl(params: Record<string, unknown>): Promise<unknown> {
    const session = requiredString(params.session, "session") as SessionId;
    const kind = params.kind === "steer" ? "steer" : params.kind === "interrupt" ? "interrupt" : "start";
    if (typeof params.app_server_url === "string") {
      this.adapter.setAppServerUrl(session, params.app_server_url);
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
        this.waiters.delete(queryId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(queryId, (decision) => {
        clearTimeout(timer);
        this.waiters.delete(queryId);
        resolve(decision);
      });
    });
  }

  private trackSession(project: string, session: SessionId): void {
    const sessions = this.sessionsByProject.get(project) ?? new Set<SessionId>();
    sessions.add(session);
    this.sessionsByProject.set(project, sessions);
  }

  private untrackSession(project: string, session: SessionId): void {
    const sessions = this.sessionsByProject.get(project);
    if (!sessions) return;
    sessions.delete(session);
    if (sessions.size === 0) this.sessionsByProject.delete(project);
  }

  private async releaseSessionLease(input: {
    session: SessionId;
    project: string;
    connectionId: string;
    manageAppServerLifecycle: boolean;
    control: BridgeControlChannel;
  }): Promise<void> {
    try {
      this.untrackSession(input.project, input.session);
      await this.adapter.disconnect(input.session);
      await this.options.storage.releaseSessionLease(input.session, input.connectionId, Date.now());
      input.control.close();
      if (input.manageAppServerLifecycle) {
        this.scheduleManagedAppServerCleanup(input.session);
      }
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to release Codex session ${input.session}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private scheduleManagedAppServerCleanup(session: SessionId): void {
    const delay = this.options.appServerCleanupDelayMs ?? DEFAULT_APP_SERVER_CLEANUP_DELAY_MS;
    const timer = setTimeout(() => {
      void this.cleanupManagedAppServerIfLeaseIsIdle(session);
    }, delay);
    timer.unref?.();
  }

  private async cleanupManagedAppServerIfLeaseIsIdle(session: SessionId): Promise<void> {
    try {
      const record = await this.options.storage.getSession(session);
      if (record?.lease_holder_connection_id) return;
      await cleanupManagedCodexAppServer(session);
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to cleanup Codex app-server for ${session}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async chatRefForConversation(conversation: Conversation): Promise<ChatRef | undefined> {
    const registration = (await this.options.storage.listAccountRegistrations({
      project: conversation.project,
      comm: conversation.comm,
      agent: conversation.agent,
    })).find((candidate) => candidate.account_label === conversation.account_label);
    if (!registration) return undefined;
    return {
      comm: conversation.comm,
      account: registration.bot_user_id as ChatRef["account"],
      chat_native_id: conversation.chat_native_id,
      thread_native_id: conversation.thread_native_id ?? undefined,
    };
  }

  private async pendingInboundForConversation(
    conversation: Conversation,
  ): Promise<PendingInboundEntry[]> {
    const owned = await this.ownedAccountKeys();
    return this.options.pendingInbound.filter((entry) =>
      owned.has(accountKey(entry)) &&
      entry.conversation.project === conversation.project,
    );
  }

  /**
   * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. See
   * the matching comment in `ClaudeBridge` for the caching contract.
   */
  private async ownedAccountKeys(): Promise<Set<string>> {
    if (this.ownedAccountsCache) return this.ownedAccountsCache;
    const registrations = await this.options.storage.listAccountRegistrations({
      agent: this.agentId,
    });
    this.ownedAccountsCache = new Set(
      registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`),
    );
    return this.ownedAccountsCache;
  }

  private removePendingInbound(entries: PendingInboundEntry[]): void {
    if (entries.length === 0) return;
    const messageIds = new Set(entries.map((entry) => entry.message.message_id));
    for (let i = this.options.pendingInbound.length - 1; i >= 0; i -= 1) {
      if (messageIds.has(this.options.pendingInbound[i].message.message_id)) {
        this.options.pendingInbound.splice(i, 1);
      }
    }
  }
}

function accountKey(entry: PendingInboundEntry): string {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}

function formatInboundMessagesForTurn(entries: PendingInboundEntry[]): string {
  if (entries.length === 0) {
    return "Check for pending daemon-delivered Telegram messages and handle them if present.";
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
      `account=${conversation.account_label}`,
      `chat_native_id=${conversation.chat_native_id}`,
      conversation.thread_native_id ? `thread_native_id=${conversation.thread_native_id}` : null,
      `conversation_id=${conversation.conversation_id}`,
      message.platform_message_id ? `platform_message_id=${message.platform_message_id}` : null,
      `message_id=${message.message_id}`,
    ].filter(Boolean).join(" ");
    return `[${new Date(message.received_at).toISOString()}] ${sender} (${envelope}): ${text}`;
  });
  return [
    "Process these daemon-delivered Telegram messages as user input. If a reply is requested, use the Telegram MCP tool.",
    "[Daemon Inbound Messages]",
    ...lines,
    "[End Daemon Inbound Messages]",
  ].join("\n");
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

export class CodexBridgeFactory implements AgentBridgeFactory {
  readonly agentId = "codex" as AgentId;
  create(context: AgentBridgeContext): AgentBridge {
    return new CodexBridge({
      storage: context.storage,
      bus: context.bus,
      pendingInbound: context.pendingInbound,
    });
  }
}

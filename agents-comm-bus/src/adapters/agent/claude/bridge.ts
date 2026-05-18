/**
 * ClaudeBridge — Claude-side of the agents-comm-bus daemon.
 *
 * Hosts the `claude_*` IPC methods, the inline-keyboard label choices
 * specific to Claude's permission / question UX, the wake-on-resolve write
 * path (`permission-response.json` + `trigger-enter`), and the per-comm
 * callback handler. The daemon constructs one ClaudeBridge and asks it to
 * `attach` to the bus + the running comm adapters; everything Claude-specific
 * stays inside this module.
 */

import crypto from "node:crypto";

import {
  SCHEMA_VERSION_SESSION,
  type AccountId,
  type AgentId,
  type CallbackEvent,
  type ChatRef,
  type CommAdapter,
  type CommId,
  type Conversation,
  type InlineKeyboardButton,
  type Query,
  type QueryId,
  type QueryRecord,
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
import { ClaudeWakeRegistry } from "./wake.js";

export type { PendingInboundEntry } from "../../../runtime/pending-inbound.js";

export interface ClaudeBridgeOptions {
  storage: Storage;
  bus: MessageBus;
  /**
   * Shared inbound queue that Claude's `claude_drain_inbound` IPC method
   * pulls from. The daemon owns the array reference so other consumers
   * (e.g. the Telegram MCP shim's `telegram_check_messages`) can drain
   * from the same queue.
   */
  pendingInbound: PendingInboundEntry[];
  /** Max queue depth before old entries are dropped. */
  pendingInboundMax?: number;
}

const DEFAULT_TTL_SECONDS = 3600;

/**
 * Outcome shape returned by claude_register_session.
 */
export interface RegisterSessionResult {
  ok: boolean;
  reason?: string;
  wake_dir?: string;
}

/**
 * Outcome shape returned by claude_open_query.
 */
export interface OpenQueryResult {
  query_id: QueryId;
  hook_response: unknown;
  hookJson: unknown;
  nativeHookJson: unknown;
}

const CLAUDE_IPC_METHODS = new Set<string>([
  "claude_register_session",
  "claude_drain_inbound",
  "claude_open_query",
]);

export class ClaudeBridge implements AgentBridge {
  readonly agentId = "claude" as AgentId;
  readonly ipcMethods: ReadonlySet<string> = CLAUDE_IPC_METHODS;

  private readonly wake = new ClaudeWakeRegistry();
  private ownedAccountsCache: Set<string> | null = null;

  constructor(private readonly options: ClaudeBridgeOptions) {
    // pendingInboundMax preserved as an option for symmetry but the daemon
    // now caps the shared queue itself; this class only drains it.
    void options.pendingInboundMax;
  }

  /**
   * Wire Claude-specific behaviors into the bus + per-comm callbacks. The
   * shared dispatch sink (pendingInbound + onInboundConversation fan-out)
   * is set up by the daemon; here we only own resolve-on-sink (write the
   * wake response) and the inline-keyboard callback handler.
   */
  attach(comms: CommAdapter[]): void {
    this.options.bus.setResolveSink({
      onResolved: async (query, decision) => {
        if (query.agent !== this.agentId) return;
        const payload = wakePayloadFromDecision(decision);
        if (!payload) return;
        await this.wake.writeResponseForSession(query.session, payload);
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
    // ClaudeBridge keeps no per-adapter state beyond the onCallback handler,
    // which is owned by the adapter and discarded when the adapter stops.
  }

  invalidateRegistrationCaches(): void {
    this.ownedAccountsCache = null;
  }

  async onInboundConversation(conversation: Conversation): Promise<void> {
    if (conversation.agent !== this.agentId) return;
    try {
      await this.wake.wakeConversation(conversation);
    } catch (error) {
      console.error(
        `agents-comm-bus: failed to write Claude wake trigger for ` +
          `${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handleIpcMethod(
    method: string,
    params: Record<string, unknown>,
    ctx: { socket?: { once(event: "close", handler: () => void): void } },
  ): Promise<unknown> {
    switch (method) {
      case "claude_register_session":
        return this.registerSession(params, ctx.socket);
      case "claude_drain_inbound":
        return this.drainInbound(params);
      case "claude_open_query":
        return this.openQuery(params);
      default:
        throw new Error(`ClaudeBridge does not handle IPC method: ${method}`);
    }
  }

  /**
   * Drain pending-inbound entries whose source `(comm, account)` belongs to
   * a Claude registration. The queue is daemon-wide and shared across
   * bridges, so each agent must filter to its own accounts — otherwise the
   * first bridge to drain sweeps the queue and starves the others. We
   * filter on `message.chat.account` (the bot_user_id) rather than the
   * derived `conversation.agent` so the check is rooted in the source
   * record contract: `(comm, bot_user_id)` uniquely identifies a
   * `(project, agent)` registration per the daemon design.
   */
  async drainPendingInbound(): Promise<PendingInboundEntry[]> {
    const owned = await this.ownedAccountKeys();
    const drained: PendingInboundEntry[] = [];
    for (let i = this.options.pendingInbound.length - 1; i >= 0; i -= 1) {
      const entry = this.options.pendingInbound[i];
      if (owned.has(accountKey(entry))) {
        drained.unshift(entry);
        this.options.pendingInbound.splice(i, 1);
      }
    }
    return drained;
  }

  /**
   * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. The
   * daemon's account registrations only change via the CLI, which requires
   * a daemon restart to take effect — so caching once per process is safe.
   * Future-proofing for runtime registration would re-fetch on miss; left
   * as a follow-up.
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

  async registerSession(
    params: Record<string, unknown>,
    socket?: { once(event: "close", handler: () => void): void },
  ): Promise<RegisterSessionResult> {
    const session = requiredString(params.session, "session") as SessionId;
    const project = requiredString(params.project, "project");
    const connectionId = typeof params.connection_id === "string"
      ? params.connection_id
      : `claude:${session}:${crypto.randomUUID()}`;
    const now = Date.now();
    const wakeDir = typeof params.wake_dir === "string"
      ? params.wake_dir
      : typeof params.wakeDir === "string"
        ? params.wakeDir
        : undefined;
    await this.options.storage.upsertSession({
      schema_version: SCHEMA_VERSION_SESSION,
      session_id: session,
      agent: "claude" as AgentId,
      project,
      created_at: now,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      most_recent_inbound_conversation_id: null,
      status: "active",
    });
    const acquired = await this.options.storage.acquireSessionLease(session, connectionId, now);
    if (!acquired) {
      return { ok: false, reason: "same-project claude session lease already held" };
    }
    const registration = this.wake.register({ session, project, wakeDir });
    socket?.once("close", () => {
      void this.options.storage.releaseSessionLease(session, connectionId, Date.now());
    });
    return { ok: true, wake_dir: registration.wakeDir };
  }

  async drainInbound(params: Record<string, unknown>): Promise<PendingInboundEntry[]> {
    const session = typeof params.session === "string" ? params.session as SessionId : undefined;
    const drained = await this.drainPendingInbound();
    if (session && drained.length > 0) {
      await this.options.storage.setSessionMostRecentInbound(
        session,
        drained[drained.length - 1].conversation.conversation_id,
      );
    }
    return drained;
  }

  async openQuery(params: Record<string, unknown>): Promise<OpenQueryResult> {
    const session = requiredString(params.session, "session") as SessionId;
    const queryInput = recordOrEmpty(params.query);
    const claudeInput = recordOrEmpty(params.claude);
    const toolName = typeof params.tool_name === "string"
      ? params.tool_name
      : typeof claudeInput.tool_name === "string"
        ? claudeInput.tool_name
        : undefined;
    const promptText = requiredString(
      params.prompt_text ?? queryInput.prompt_text,
      "prompt_text",
    );
    const rawKind = params.kind ?? queryInput.kind;
    const kind: "approval" | "choice" | "freetext" =
      rawKind === "choice" || rawKind === "freetext" || rawKind === "approval"
        ? rawKind
        : "approval";
    const queryId = `q_${crypto.randomUUID()}` as QueryId;
    const sessionRecord = await this.options.storage.getSession(session);
    const conversation = sessionRecord?.most_recent_inbound_conversation_id
      ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
      : null;
    const originChat = conversation ? await this.chatRefForConversation(conversation) : undefined;
    const options = Array.isArray(params.options)
      ? params.options.map(String)
      : Array.isArray(queryInput.options)
        ? queryInput.options.map(String)
        : undefined;
    const query: Query = {
      schema_version: 1,
      query_id: queryId,
      agent: "claude" as AgentId,
      session,
      kind,
      prompt_text: promptText,
      options,
      origin_chat: originChat,
      created_at: Date.now(),
      ttl_seconds:
        typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS,
    };
    await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
    await this.options.bus.openQuery(query);
    if (originChat) {
      const promptFormat = params.prompt_format ?? queryInput.prompt_format;
      const inlineKeyboard = inlineKeyboardForQuery(queryId, kind, options);
      await this.options.bus.send({
        session,
        comm: originChat.comm,
        target: originChat,
        payload: {
          text: promptText,
          format: promptFormat === "html" ? "html" : "plain",
          inline_keyboard: inlineKeyboard,
        },
        idempotencyKey: `query:${queryId}`,
      });
    }

    const hookResponse = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
    return {
      query_id: queryId,
      hook_response: hookResponse,
      hookJson: hookResponse,
      nativeHookJson: hookResponse,
    };
  }

  private async handleCommCallback(
    comm: CommAdapter,
    event: CallbackEvent,
  ): Promise<void> {
    const parsed = parseCallbackData(event.data);
    if (!parsed) {
      if (comm.answerCallback) {
        await comm.answerCallback(event.callback_id, {
          text: "Unrecognized button payload",
        });
      }
      return;
    }

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

    switch (outcome.kind) {
      case "resolved": {
        const text = ackTextFor(outcome.decision);
        await comm.answerCallback(event.callback_id, { text });
        if (comm.editMessage) {
          try {
            await comm.editMessage(
              event.chat_native_id,
              event.message_native_id,
              `✓ Resolved via Telegram (${text}).`,
            );
          } catch {
            // Best-effort UI polish; ignore failures.
          }
        }
        return;
      }
      case "awaiting_freetext":
        await comm.answerCallback(event.callback_id, {
          text: "Now send your custom reply as a message.",
          showAlert: true,
        });
        if (comm.editMessage) {
          try {
            await comm.editMessage(
              event.chat_native_id,
              event.message_native_id,
              "💬 Awaiting your custom reply… (send any text in this chat).",
            );
          } catch {
            // Best-effort.
          }
        }
        return;
      case "already_resolved":
        await comm.answerCallback(event.callback_id, {
          text: "Already resolved.",
          showAlert: false,
        });
        return;
      case "expired":
        await comm.answerCallback(event.callback_id, {
          text: "This prompt expired before you answered.",
          showAlert: true,
        });
        return;
      case "unknown_query":
        await comm.answerCallback(event.callback_id, {
          text: "Unknown query.",
        });
        return;
      case "invalid_value":
        await comm.answerCallback(event.callback_id, {
          text: `Unrecognized value: ${outcome.value}`,
        });
        return;
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
}

function accountKey(entry: PendingInboundEntry): string {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}

function inlineKeyboardForQuery(
  queryId: QueryId,
  kind: "approval" | "choice" | "freetext",
  options: readonly string[] | undefined,
): InlineKeyboardButton[][] | undefined {
  if (kind === "approval") {
    return [
      [
        { text: "✅ Allow", callback_data: `q:${queryId}:y` },
        { text: "❌ Deny", callback_data: `q:${queryId}:n` },
      ],
      [{ text: "🔓 Always", callback_data: `q:${queryId}:a` }],
    ];
  }
  if (kind === "choice") {
    const rows: InlineKeyboardButton[][] = (options ?? []).map((label, index) => [
      {
        text: `${index + 1}. ${truncateButtonText(label)}`,
        callback_data: `q:${queryId}:${index + 1}`,
      },
    ]);
    rows.push([
      { text: "💬 Other (type a reply)", callback_data: `q:${queryId}:other` },
    ]);
    return rows;
  }
  return undefined;
}

function truncateButtonText(label: string): string {
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 47)}…`;
}

function wakePayloadFromDecision(
  decision: ResolvedDecision,
): { response: string; prompt_type: "permission" | "question" | "freetext" } | null {
  switch (decision.decision) {
    case "allow":
      return { response: "y", prompt_type: "permission" };
    case "deny":
      return { response: "n", prompt_type: "permission" };
    case "always_allow":
      return { response: "a", prompt_type: "permission" };
    case "select_option": {
      const idx = decision.selected_option_index;
      if (typeof idx !== "number") return null;
      return { response: String(idx + 1), prompt_type: "question" };
    }
    case "text":
      if (!decision.text) return null;
      return { response: decision.text, prompt_type: "freetext" };
    default:
      return null;
  }
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
    case "deny":
      return "Denied";
    case "always_allow":
      return "Always allowed";
    case "select_option":
      return `Selected option ${typeof decision.selected_option_index === "number" ? decision.selected_option_index + 1 : "?"}`;
    case "text":
      return "Reply received";
    default:
      return "Recorded";
  }
}

function hookResponseForUnresolvedClaudeQuery(params: Record<string, unknown>): unknown {
  if (params.tool_name === "AskUserQuestion") {
    return { decision: { behavior: "allow" } };
  }
  return { decision: { behavior: "ask" } };
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

export class ClaudeBridgeFactory implements AgentBridgeFactory {
  readonly agentId = "claude" as AgentId;
  create(context: AgentBridgeContext): AgentBridge {
    return new ClaudeBridge({
      storage: context.storage,
      bus: context.bus,
      pendingInbound: context.pendingInbound,
    });
  }
}

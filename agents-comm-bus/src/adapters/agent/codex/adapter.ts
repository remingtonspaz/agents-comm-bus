import crypto from "node:crypto";

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  ControlChannel,
  Message,
  Query,
  QueryChannel,
  QueryId,
  QueryKind,
  ResolvedDecision,
  SessionId,
} from "../../../../../agents-comm-bus-core/dist/index.js";
import { SCHEMA_VERSION_QUERY } from "../../../../../agents-comm-bus-core/dist/index.js";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  WebSocketCodexAppServerClient,
  type CodexAppServerClient,
  type CodexTurnResult,
} from "./app-server.js";

export interface CodexHookPayload {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface CodexQueryMetadata {
  hook_event_name?: string;
  tool_name: string;
  prompt_type: "permission";
  codex_session_id?: string;
}

export interface CodexQueryMapping {
  query: Query;
  metadata: CodexQueryMetadata;
}

export interface CodexAgentAdapterOptions {
  now?: () => number;
  defaultTtlSeconds?: number;
  defaultAppServerUrl?: string;
  wakePlaceholder?: string;
  queryIdFactory?: (payload: CodexHookPayload) => QueryId;
  appServerClientFactory?: (url: string) => CodexAppServerClient;
}

export interface CodexHookDecision {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision: {
      behavior: "allow" | "deny";
      message?: string;
    };
  };
}

interface SessionState {
  controlChannel: ControlChannel;
  queuedInbound: Message[];
  openQueries: Map<QueryId, QueryChannel>;
  appServerUrl?: string;
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id = "codex" as AgentId;

  readonly capabilities: AgentCapabilities = {
    canWake: true,
    canSteer: true,
    canInterrupt: false,
    midTurnPolicy: "steer",
    supportedQueryKinds: ["approval"],
  };

  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly now: () => number;
  private readonly defaultTtlSeconds: number;
  private readonly defaultAppServerUrl: string;
  private readonly wakePlaceholder: string;
  private readonly queryIdFactory: (payload: CodexHookPayload) => QueryId;
  private readonly appServerClientFactory: (url: string) => CodexAppServerClient;

  constructor(private readonly options: CodexAgentAdapterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300;
    this.defaultAppServerUrl = options.defaultAppServerUrl ?? DEFAULT_CODEX_APP_SERVER_URL;
    this.wakePlaceholder = options.wakePlaceholder ?? ".";
    this.queryIdFactory =
      options.queryIdFactory ?? (() => `codex:${crypto.randomUUID()}` as QueryId);
    this.appServerClientFactory =
      options.appServerClientFactory ?? ((url) => new WebSocketCodexAppServerClient(url));
  }

  async connect(
    session: SessionId,
    controlChannel: ControlChannel,
  ): Promise<void> {
    const state: SessionState = {
      controlChannel,
      queuedInbound: [],
      openQueries: new Map(),
    };
    this.sessions.set(session, state);
    controlChannel.onClose(() => {
      this.sessions.delete(session);
    });
    await controlChannel.send({
      type: "agent.connected",
      agent: this.id,
      session,
      capabilities: this.capabilities,
    });
  }

  async disconnect(session: SessionId): Promise<void> {
    this.sessions.delete(session);
  }

  setAppServerUrl(session: SessionId, url: string | undefined): void {
    const state = this.sessions.get(session);
    if (state && url) state.appServerUrl = url;
  }

  async deliverInbound(session: SessionId, message: Message): Promise<void> {
    const state = this.requireSession(session);
    state.queuedInbound.push(message);
    await state.controlChannel.send({
      type: "inbound.queued",
      agent: this.id,
      session,
      message,
      queueDepth: state.queuedInbound.length,
      midTurnPolicy: this.capabilities.midTurnPolicy,
    });
  }

  async openQuery(
    session: SessionId,
    query: Query,
    queryChannel: QueryChannel,
  ): Promise<void> {
    if (!this.supportsQueryKind(query.kind)) {
      throw new Error(`Codex adapter does not support query kind: ${query.kind}`);
    }
    const state = this.requireSession(session);
    state.openQueries.set(query.query_id, queryChannel);
    queryChannel.onClose(() => {
      state.openQueries.delete(query.query_id);
    });
    await queryChannel.send({
      type: "query.opened",
      agent: this.id,
      session,
      query,
    });
    await state.controlChannel.send({
      type: "query.opened",
      agent: this.id,
      session,
      query_id: query.query_id,
      kind: query.kind,
    });
  }

  async wake(session: SessionId): Promise<void> {
    const result = await this.clientFor(session).wakeMostRecentThread(this.wakePlaceholder);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.wake",
      agent: this.id,
      session,
      result,
    });
    throwIfTurnFailed(result);
  }

  async steer(session: SessionId, payload: unknown): Promise<void> {
    const text = steerText(payload);
    const result = await this.clientFor(session).steerMostRecentThread(text);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.steer",
      agent: this.id,
      session,
      result,
    });
    throwIfTurnFailed(result);
  }

  async interrupt(_session: SessionId): Promise<void> {
    throw new Error("Codex adapter does not support interrupt");
  }

  drainQueuedInbound(session: SessionId): Message[] {
    const state = this.requireSession(session);
    const drained = [...state.queuedInbound];
    state.queuedInbound.length = 0;
    return drained;
  }

  mapHookPayloadToQuery(
    session: SessionId,
    payload: CodexHookPayload,
  ): CodexQueryMapping {
    return mapCodexHookPayloadToQuery(session, payload, {
      agent: this.id,
      now: this.now,
      ttlSeconds: this.defaultTtlSeconds,
      queryId: this.queryIdFactory(payload),
    });
  }

  private supportsQueryKind(kind: QueryKind): boolean {
    return this.capabilities.supportedQueryKinds.includes(kind);
  }

  private clientFor(session: SessionId): CodexAppServerClient {
    const url = this.sessions.get(session)?.appServerUrl ?? this.defaultAppServerUrl;
    return this.appServerClientFactory(url);
  }

  private requireSession(session: SessionId): SessionState {
    const state = this.sessions.get(session);
    if (!state) throw new Error(`Codex session is not connected: ${session}`);
    return state;
  }
}

export function mapCodexHookPayloadToQuery(
  session: SessionId,
  payload: CodexHookPayload,
  options: {
    agent?: AgentId;
    now?: () => number;
    ttlSeconds?: number;
    queryId?: QueryId;
  } = {},
): CodexQueryMapping {
  const agent = options.agent ?? ("codex" as AgentId);
  const now = options.now ?? Date.now;
  const toolName = payload.tool_name ?? "PermissionRequest";
  const query: Query = {
    schema_version: SCHEMA_VERSION_QUERY,
    query_id: options.queryId ?? (`codex:${crypto.randomUUID()}` as QueryId),
    agent,
    session,
    kind: "approval",
    prompt_text: formatCodexPermissionPrompt(toolName, payload.tool_input),
    created_at: now(),
    ttl_seconds: options.ttlSeconds ?? 300,
  };
  return {
    query,
    metadata: {
      hook_event_name: payload.hook_event_name,
      tool_name: toolName,
      prompt_type: "permission",
      codex_session_id: payload.session_id,
    },
  };
}

export function codexDecisionFromResolution(resolution: ResolvedDecision | null): CodexHookDecision {
  if (!resolution) {
    return codexHookDecision("deny", "Telegram approval timed out");
  }
  if (resolution.decision === "allow" || resolution.decision === "always_allow") {
    return codexHookDecision("allow");
  }
  return codexHookDecision("deny", `Denied via Telegram (${resolution.decision})`);
}

export function codexHookDecision(
  behavior: "allow" | "deny",
  message?: string,
): CodexHookDecision {
  const decision: CodexHookDecision["hookSpecificOutput"]["decision"] = { behavior };
  if (message) decision.message = message;
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  };
}

function formatCodexPermissionPrompt(toolName: string, toolInput: unknown): string {
  const input = recordOrEmpty(toolInput);
  if (toolName === "Bash" && typeof input.command === "string") {
    return `Codex requests permission to run Bash: ${input.command}`;
  }
  if (typeof input.file_path === "string") {
    return `Codex requests permission to use ${toolName} on ${input.file_path}`;
  }
  return `Codex requests permission to use ${toolName}.`;
}

function steerText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).text === "string") {
    return (payload as Record<string, string>).text;
  }
  return JSON.stringify(payload);
}

function throwIfTurnFailed(result: CodexTurnResult): void {
  if (!result.ok) {
    throw new Error(`Codex app-server turn control failed: ${result.reason}${result.error ? `: ${result.error}` : ""}`);
  }
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

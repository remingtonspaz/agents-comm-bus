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
} from "agents-comm-bus-core";
import { SCHEMA_VERSION_QUERY } from "agents-comm-bus-core";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  WebSocketCodexAppServerClient,
  type CodexAppServerClient,
  type CodexRecordedTarget,
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
  project?: string;
  threadId?: string;
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

  setWakeTarget(
    session: SessionId,
    target: { project: string; appServerUrl?: string; threadId?: string },
  ): void {
    const state = this.sessions.get(session);
    if (!state) return;
    state.project = target.project;
    if (target.appServerUrl) state.appServerUrl = target.appServerUrl;
    if (target.threadId) state.threadId = target.threadId;
  }

  recordedTargetFor(session: SessionId): CodexRecordedTarget | null {
    const state = this.sessions.get(session);
    if (!state?.threadId || !state.project) return null;
    return {
      threadId: state.threadId,
      expectedProject: state.project,
    };
  }

  appServerUrlFor(session: SessionId): string {
    return this.sessions.get(session)?.appServerUrl ?? this.defaultAppServerUrl;
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
    const target = this.requireRecordedTarget(session);
    const result = await this.clientFor(session).wakeRecordedTarget(target, this.wakePlaceholder);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.wake",
      agent: this.id,
      session,
      result,
    });
    throwIfTurnFailed(result);
  }

  async wakeOrSteer(session: SessionId, payload: unknown): Promise<CodexTurnResult> {
    const target = this.requireRecordedTarget(session);
    const client = this.clientFor(session);
    const text = steerText(payload);
    const steerResult = await client.steerRecordedTarget(target, text);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.steer",
      agent: this.id,
      session,
      result: steerResult,
    });
    if (steerResult.ok) return steerResult;
    if (isCodexWakeTargetValidationFailure(steerResult.reason)) {
      return steerResult;
    }

    const wakeResult = await client.wakeRecordedTarget(target, text);
    await this.sessions.get(session)?.controlChannel.send({
      type: "turn.wake",
      agent: this.id,
      session,
      result: wakeResult,
      fallback_from: steerResult,
    });
    if (!wakeResult.ok) return wakeResult;
    return { ...wakeResult, fallbackFrom: steerResult };
  }

  async steer(session: SessionId, payload: unknown): Promise<void> {
    const target = this.requireRecordedTarget(session);
    const text = steerText(payload);
    const result = await this.clientFor(session).steerRecordedTarget(target, text);
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

  private requireRecordedTarget(session: SessionId): CodexRecordedTarget {
    const target = this.recordedTargetFor(session);
    if (!target) {
      throw new Error(
        `Codex wake target is not configured for session ${session} (missing threadId or project)`,
      );
    }
    return target;
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

export function isCodexWakeTargetValidationFailure(reason: string | undefined): boolean {
  return reason === "missing-recorded-target"
    || reason === "recorded-thread-absent"
    || reason === "recorded-thread-not-live"
    || reason === "recorded-thread-wrong-project"
    || reason === "recorded-thread-missing-cwd"
    || reason === "listThreads-failed";
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

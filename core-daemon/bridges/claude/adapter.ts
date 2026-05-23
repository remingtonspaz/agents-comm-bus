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
} from "../../../packages/core-contracts/dist/index.js";
import { SCHEMA_VERSION_QUERY } from "../../../packages/core-contracts/dist/index.js";

export type ClaudePromptType =
  | "permission"
  | "question"
  | "plan_approval"
  | "plan_entry";

export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
}

export interface ClaudeQueryMetadata {
  hook_event_name?: string;
  tool_name: string;
  prompt_type: ClaudePromptType;
  claude_session_id?: string;
  question_index?: number;
}

export interface ClaudeQueryMapping {
  query: Query;
  metadata: ClaudeQueryMetadata;
}

export interface ClaudeAgentAdapterOptions {
  now?: () => number;
  defaultTtlSeconds?: number;
  queryIdFactory?: (payload: ClaudeHookPayload) => QueryId;
  wakeSession?: (session: SessionId) => Promise<void>;
}

export interface ClaudeHookDecision {
  decision: {
    behavior: "allow" | "deny" | "ask";
  };
}

interface SessionState {
  controlChannel: ControlChannel;
  queuedInbound: Message[];
  openQueries: Map<QueryId, QueryChannel>;
}

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly id = "claude" as AgentId;

  readonly capabilities: AgentCapabilities = {
    canWake: true,
    canSteer: false,
    canInterrupt: false,
    midTurnPolicy: "queue",
    supportedQueryKinds: ["approval", "choice", "freetext"],
  };

  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly now: () => number;
  private readonly defaultTtlSeconds: number;
  private readonly queryIdFactory: (payload: ClaudeHookPayload) => QueryId;

  constructor(private readonly options: ClaudeAgentAdapterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300;
    this.queryIdFactory =
      options.queryIdFactory ?? (() => `claude:${crypto.randomUUID()}` as QueryId);
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

  async deliverInbound(session: SessionId, message: Message): Promise<void> {
    const state = this.requireSession(session);
    state.queuedInbound.push(message);
    await state.controlChannel.send({
      type: "inbound.queued",
      agent: this.id,
      session,
      message,
      queueDepth: state.queuedInbound.length,
    });
  }

  async openQuery(
    session: SessionId,
    query: Query,
    queryChannel: QueryChannel,
  ): Promise<void> {
    if (!this.supportsQueryKind(query.kind)) {
      throw new Error(`Claude adapter does not support query kind: ${query.kind}`);
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
    await this.options.wakeSession?.(session);
    const state = this.sessions.get(session);
    await state?.controlChannel.send({
      type: "turn.wake",
      agent: this.id,
      session,
    });
  }

  async steer(_session: SessionId, _payload: unknown): Promise<void> {
    throw new Error("Claude adapter does not support mid-turn steering");
  }

  async interrupt(_session: SessionId): Promise<void> {
    throw new Error("Claude adapter does not support interrupt");
  }

  drainQueuedInbound(session: SessionId): Message[] {
    const state = this.requireSession(session);
    const drained = [...state.queuedInbound];
    state.queuedInbound.length = 0;
    return drained;
  }

  mapHookPayloadToQuery(
    session: SessionId,
    payload: ClaudeHookPayload,
  ): ClaudeQueryMapping {
    return mapClaudeHookPayloadToQuery(session, payload, {
      agent: this.id,
      now: this.now,
      ttlSeconds: this.defaultTtlSeconds,
      queryId: this.queryIdFactory(payload),
    });
  }

  private supportsQueryKind(kind: QueryKind): boolean {
    return this.capabilities.supportedQueryKinds.includes(kind);
  }

  private requireSession(session: SessionId): SessionState {
    const state = this.sessions.get(session);
    if (!state) throw new Error(`Claude session is not connected: ${session}`);
    return state;
  }
}

export function mapClaudeHookPayloadToQuery(
  session: SessionId,
  payload: ClaudeHookPayload,
  options: {
    agent?: AgentId;
    now?: () => number;
    ttlSeconds?: number;
    queryId?: QueryId;
  } = {},
): ClaudeQueryMapping {
  const agent = options.agent ?? ("claude" as AgentId);
  const now = options.now ?? Date.now;
  const toolName = payload.tool_name ?? "PermissionRequest";
  const classification = classifyClaudeTool(toolName, payload.tool_input);
  const query: Query = {
    schema_version: SCHEMA_VERSION_QUERY,
    query_id: options.queryId ?? (`claude:${crypto.randomUUID()}` as QueryId),
    agent,
    session,
    kind: classification.kind,
    prompt_text: classification.promptText,
    options: classification.options,
    created_at: now(),
    ttl_seconds: options.ttlSeconds ?? 300,
  };
  return {
    query,
    metadata: {
      hook_event_name: payload.hook_event_name,
      tool_name: toolName,
      prompt_type: classification.promptType,
      claude_session_id: payload.session_id,
      question_index: classification.questionIndex,
    },
  };
}

export function claudeDecisionFromResolution(
  query: Query,
  resolution: ResolvedDecision,
): ClaudeHookDecision {
  if (query.kind === "approval") {
    if (resolution.decision === "allow" || resolution.decision === "always_allow") {
      return { decision: { behavior: "allow" } };
    }
    if (resolution.decision === "deny") {
      return { decision: { behavior: "deny" } };
    }
  }
  return { decision: { behavior: "ask" } };
}

function classifyClaudeTool(
  toolName: string,
  toolInput: unknown,
): {
  kind: QueryKind;
  promptType: ClaudePromptType;
  promptText: string;
  options?: readonly string[];
  questionIndex?: number;
} {
  if (toolName === "AskUserQuestion") {
    const question = firstQuestion(toolInput);
    return {
      kind: question.options.length > 0 ? "choice" : "freetext",
      promptType: "question",
      promptText: question.prompt,
      options: question.options.length > 0 ? question.options : undefined,
      questionIndex: 0,
    };
  }

  if (toolName === "ExitPlanMode") {
    return {
      kind: "approval",
      promptType: "plan_approval",
      promptText: "Claude has finished planning and wants approval to proceed.",
    };
  }

  if (toolName === "EnterPlanMode") {
    return {
      kind: "approval",
      promptType: "plan_entry",
      promptText: "Claude wants to switch to plan mode before proceeding.",
    };
  }

  return {
    kind: "approval",
    promptType: "permission",
    promptText: formatPermissionPrompt(toolName, toolInput),
  };
}

function firstQuestion(toolInput: unknown): { prompt: string; options: string[] } {
  const input = recordOrEmpty(toolInput);
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const question = recordOrEmpty(questions[0]);
  const options = Array.isArray(question.options)
    ? question.options
        .map((option) => recordOrEmpty(option).label)
        .filter((label): label is string => typeof label === "string" && label.length > 0)
    : [];
  return {
    prompt:
      typeof question.question === "string" && question.question.length > 0
        ? question.question
        : "Claude has a question.",
    options,
  };
}

function formatPermissionPrompt(toolName: string, toolInput: unknown): string {
  const input = recordOrEmpty(toolInput);
  if (toolName === "Bash" && typeof input.command === "string") {
    return `Claude requests permission to run Bash: ${input.command}`;
  }
  if (typeof input.file_path === "string") {
    return `Claude requests permission to use ${toolName} on ${input.file_path}`;
  }
  return `Claude requests permission to use ${toolName}.`;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

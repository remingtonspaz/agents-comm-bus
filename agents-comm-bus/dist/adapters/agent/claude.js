import crypto from "node:crypto";
import { SCHEMA_VERSION_QUERY } from "../../../../agents-comm-bus-core/dist/index.js";
export class ClaudeAgentAdapter {
    options;
    id = "claude";
    capabilities = {
        canWake: true,
        canSteer: false,
        canInterrupt: false,
        midTurnPolicy: "queue",
        supportedQueryKinds: ["approval", "choice", "freetext"],
    };
    sessions = new Map();
    now;
    defaultTtlSeconds;
    queryIdFactory;
    constructor(options = {}) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300;
        this.queryIdFactory =
            options.queryIdFactory ?? (() => `claude:${crypto.randomUUID()}`);
    }
    async connect(session, controlChannel) {
        const state = {
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
    async disconnect(session) {
        this.sessions.delete(session);
    }
    async deliverInbound(session, message) {
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
    async openQuery(session, query, queryChannel) {
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
    async wake(session) {
        await this.options.wakeSession?.(session);
        const state = this.sessions.get(session);
        await state?.controlChannel.send({
            type: "turn.wake",
            agent: this.id,
            session,
        });
    }
    async steer(_session, _payload) {
        throw new Error("Claude adapter does not support mid-turn steering");
    }
    async interrupt(_session) {
        throw new Error("Claude adapter does not support interrupt");
    }
    drainQueuedInbound(session) {
        const state = this.requireSession(session);
        const drained = [...state.queuedInbound];
        state.queuedInbound.length = 0;
        return drained;
    }
    mapHookPayloadToQuery(session, payload) {
        return mapClaudeHookPayloadToQuery(session, payload, {
            agent: this.id,
            now: this.now,
            ttlSeconds: this.defaultTtlSeconds,
            queryId: this.queryIdFactory(payload),
        });
    }
    supportsQueryKind(kind) {
        return this.capabilities.supportedQueryKinds.includes(kind);
    }
    requireSession(session) {
        const state = this.sessions.get(session);
        if (!state)
            throw new Error(`Claude session is not connected: ${session}`);
        return state;
    }
}
export function mapClaudeHookPayloadToQuery(session, payload, options = {}) {
    const agent = options.agent ?? "claude";
    const now = options.now ?? Date.now;
    const toolName = payload.tool_name ?? "PermissionRequest";
    const classification = classifyClaudeTool(toolName, payload.tool_input);
    const query = {
        schema_version: SCHEMA_VERSION_QUERY,
        query_id: options.queryId ?? `claude:${crypto.randomUUID()}`,
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
export function claudeDecisionFromResolution(query, resolution) {
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
function classifyClaudeTool(toolName, toolInput) {
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
function firstQuestion(toolInput) {
    const input = recordOrEmpty(toolInput);
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const question = recordOrEmpty(questions[0]);
    const options = Array.isArray(question.options)
        ? question.options
            .map((option) => recordOrEmpty(option).label)
            .filter((label) => typeof label === "string" && label.length > 0)
        : [];
    return {
        prompt: typeof question.question === "string" && question.question.length > 0
            ? question.question
            : "Claude has a question.",
        options,
    };
}
function formatPermissionPrompt(toolName, toolInput) {
    const input = recordOrEmpty(toolInput);
    if (toolName === "Bash" && typeof input.command === "string") {
        return `Claude requests permission to run Bash: ${input.command}`;
    }
    if (typeof input.file_path === "string") {
        return `Claude requests permission to use ${toolName} on ${input.file_path}`;
    }
    return `Claude requests permission to use ${toolName}.`;
}
function recordOrEmpty(value) {
    return value && typeof value === "object" ? value : {};
}
//# sourceMappingURL=claude.js.map
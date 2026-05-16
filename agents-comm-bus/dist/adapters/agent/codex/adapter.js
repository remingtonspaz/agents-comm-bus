import crypto from "node:crypto";
import { SCHEMA_VERSION_QUERY } from "../../../../../agents-comm-bus-core/dist/index.js";
import { DEFAULT_CODEX_APP_SERVER_URL, WebSocketCodexAppServerClient, } from "./app-server.js";
export class CodexAgentAdapter {
    options;
    id = "codex";
    capabilities = {
        canWake: true,
        canSteer: true,
        canInterrupt: false,
        midTurnPolicy: "steer",
        supportedQueryKinds: ["approval"],
    };
    sessions = new Map();
    now;
    defaultTtlSeconds;
    defaultAppServerUrl;
    wakePlaceholder;
    queryIdFactory;
    appServerClientFactory;
    constructor(options = {}) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300;
        this.defaultAppServerUrl = options.defaultAppServerUrl ?? DEFAULT_CODEX_APP_SERVER_URL;
        this.wakePlaceholder = options.wakePlaceholder ?? ".";
        this.queryIdFactory =
            options.queryIdFactory ?? (() => `codex:${crypto.randomUUID()}`);
        this.appServerClientFactory =
            options.appServerClientFactory ?? ((url) => new WebSocketCodexAppServerClient(url));
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
    setAppServerUrl(session, url) {
        const state = this.sessions.get(session);
        if (state && url)
            state.appServerUrl = url;
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
            midTurnPolicy: this.capabilities.midTurnPolicy,
        });
    }
    async openQuery(session, query, queryChannel) {
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
    async wake(session) {
        const result = await this.clientFor(session).wakeMostRecentThread(this.wakePlaceholder);
        await this.sessions.get(session)?.controlChannel.send({
            type: "turn.wake",
            agent: this.id,
            session,
            result,
        });
        throwIfTurnFailed(result);
    }
    async steer(session, payload) {
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
    async interrupt(_session) {
        throw new Error("Codex adapter does not support interrupt");
    }
    drainQueuedInbound(session) {
        const state = this.requireSession(session);
        const drained = [...state.queuedInbound];
        state.queuedInbound.length = 0;
        return drained;
    }
    mapHookPayloadToQuery(session, payload) {
        return mapCodexHookPayloadToQuery(session, payload, {
            agent: this.id,
            now: this.now,
            ttlSeconds: this.defaultTtlSeconds,
            queryId: this.queryIdFactory(payload),
        });
    }
    supportsQueryKind(kind) {
        return this.capabilities.supportedQueryKinds.includes(kind);
    }
    clientFor(session) {
        const url = this.sessions.get(session)?.appServerUrl ?? this.defaultAppServerUrl;
        return this.appServerClientFactory(url);
    }
    requireSession(session) {
        const state = this.sessions.get(session);
        if (!state)
            throw new Error(`Codex session is not connected: ${session}`);
        return state;
    }
}
export function mapCodexHookPayloadToQuery(session, payload, options = {}) {
    const agent = options.agent ?? "codex";
    const now = options.now ?? Date.now;
    const toolName = payload.tool_name ?? "PermissionRequest";
    const query = {
        schema_version: SCHEMA_VERSION_QUERY,
        query_id: options.queryId ?? `codex:${crypto.randomUUID()}`,
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
export function codexDecisionFromResolution(resolution) {
    if (!resolution) {
        return codexHookDecision("deny", "Telegram approval timed out");
    }
    if (resolution.decision === "allow" || resolution.decision === "always_allow") {
        return codexHookDecision("allow");
    }
    return codexHookDecision("deny", `Denied via Telegram (${resolution.decision})`);
}
export function codexHookDecision(behavior, message) {
    const decision = { behavior };
    if (message)
        decision.message = message;
    return {
        hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision,
        },
    };
}
function formatCodexPermissionPrompt(toolName, toolInput) {
    const input = recordOrEmpty(toolInput);
    if (toolName === "Bash" && typeof input.command === "string") {
        return `Codex requests permission to run Bash: ${input.command}`;
    }
    if (typeof input.file_path === "string") {
        return `Codex requests permission to use ${toolName} on ${input.file_path}`;
    }
    return `Codex requests permission to use ${toolName}.`;
}
function steerText(payload) {
    if (typeof payload === "string")
        return payload;
    if (payload && typeof payload === "object" && typeof payload.text === "string") {
        return payload.text;
    }
    return JSON.stringify(payload);
}
function throwIfTurnFailed(result) {
    if (!result.ok) {
        throw new Error(`Codex app-server turn control failed: ${result.reason}${result.error ? `: ${result.error}` : ""}`);
    }
}
function recordOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=adapter.js.map
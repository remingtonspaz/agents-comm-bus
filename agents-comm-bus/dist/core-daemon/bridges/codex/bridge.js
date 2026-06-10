import crypto from "node:crypto";
import { SCHEMA_VERSION_SESSION, } from "agents-comm-bus-core";
import { normalizeProjectPath } from "../../project-path.js";
import { removePendingInboundEntries } from "../../runtime/durable-inbound.js";
import { CodexAgentAdapter, codexDecisionFromResolution, codexHookDecision, } from "./adapter.js";
import { cleanupManagedCodexAppServer } from "./app-server-lifecycle.js";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_QUERY_POLL_TIMEOUT_MS = 9 * 60 * 1000;
const DEFAULT_APP_SERVER_CLEANUP_DELAY_MS = 3_000;
const DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS = 10_000;
const CODEX_IPC_METHODS = new Set([
    "codex_bootstrap_status",
    "codex_register_session",
    "codex_drain_inbound",
    "codex_open_query",
    "codex_turn_control",
]);
export class CodexBridge {
    options;
    agentId = "codex";
    ipcMethods = CODEX_IPC_METHODS;
    adapter;
    waiters = new Map();
    sessionsByProject = new Map();
    activeLeases = new Map();
    ownedAccountsCache = null;
    ownerCheckTimer = null;
    constructor(options) {
        this.options = options;
        this.adapter = new CodexAgentAdapter({
            defaultAppServerUrl: options.defaultAppServerUrl ?? process.env.CODEX_APP_SERVER_URL,
            appServerClientFactory: options.appServerClientFactory,
        });
    }
    attach(comms) {
        this.options.bus.setResolveSink({
            onResolved: async (query, decision) => {
                if (query.agent !== this.agentId)
                    return;
                this.waiters.get(query.query_id)?.(decision);
            },
        });
        for (const comm of comms) {
            this.attachComm(comm);
        }
    }
    attachComm(comm) {
        if (typeof comm.onCallback === "function") {
            comm.onCallback(async (event) => {
                await this.handleCommCallback(comm, event);
            });
        }
    }
    detachComm(_commId, _accountId) {
        // CodexBridge keeps no per-adapter state.
    }
    invalidateRegistrationCaches() {
        this.ownedAccountsCache = null;
    }
    async onInboundConversation(conversation) {
        if (conversation.agent !== this.agentId)
            return;
        const sessions = this.sessionsByProject.get(normalizeProjectPath(conversation.project));
        const session = sessions?.values().next().value;
        if (!session) {
            await this.auditWake("agent_wake_skipped", conversation, undefined, {
                reason: "no_codex_session_for_project",
            });
            return;
        }
        const pendingForSession = await this.pendingInboundForConversation(conversation);
        const mostRecentConversationId = pendingForSession.at(-1)?.conversation.conversation_id ?? conversation.conversation_id;
        await this.options.storage.setSessionMostRecentInbound(session, mostRecentConversationId);
        await this.auditWake("agent_wake_attempt", conversation, session, {
            app_server_url: this.adapter.appServerUrlFor(session),
            pending_count: pendingForSession.length,
            pending_message_ids: pendingForSession.map((entry) => entry.message.message_id),
            pending_conversation_ids: [...new Set(pendingForSession.map((entry) => entry.conversation.conversation_id))],
        });
        try {
            const result = await this.adapter.wakeOrSteer(session, formatInboundMessagesForTurn(pendingForSession));
            if (result.ok) {
                await this.auditWake("agent_wake_succeeded", conversation, session, {
                    app_server_url: this.adapter.appServerUrlFor(session),
                    method: result.method,
                    thread_id: result.threadId,
                    fallback_reason: result.fallbackFrom?.reason,
                    fallback_error: result.fallbackFrom?.error,
                    fallback_thread_id: result.fallbackFrom?.threadId,
                    pending_count: pendingForSession.length,
                    removed_pending_count: pendingForSession.length,
                });
                await this.removePendingInbound(pendingForSession);
            }
        }
        catch (error) {
            await this.auditWake("agent_wake_failed", conversation, session, {
                app_server_url: this.adapter.appServerUrlFor(session),
                pending_count: pendingForSession.length,
                error: error instanceof Error ? error.message : String(error),
            });
            console.error(`agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async handleIpcMethod(method, params, ctx) {
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
    async bootstrapStatus(params) {
        const project = normalizeProjectPath(requiredString(params.project, "project"));
        const registrations = await this.options.storage.listAccountRegistrations({
            project,
            agent: this.agentId,
        });
        const hasAppServerUrl = typeof params.app_server_url === "string" &&
            params.app_server_url.trim().length > 0;
        const hasManagedSession = typeof params.managed_session_id === "string" &&
            params.managed_session_id.trim().length > 0;
        const managedAppServerPresent = hasAppServerUrl &&
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
    async registerSession(params, socket) {
        const session = requiredString(params.session, "session");
        const project = normalizeProjectPath(requiredString(params.project, "project"));
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
            lease_owner_process_pid: null,
            lease_owner_process_label: null,
            lease_owner_process_registered_at: null,
            most_recent_inbound_conversation_id: null,
            status: "active",
        });
        const replaceExistingLease = params.replace_existing_lease === true ||
            params.persist_after_disconnect === true;
        const leaseOwner = sessionLeaseOwnerFromParams(params, "codex");
        const acquired = await this.options.storage.acquireSessionLease(session, connectionId, now, leaseOwner);
        if (!acquired) {
            const existing = await this.options.storage.getSession(session);
            if (existing?.lease_holder_connection_id && replaceExistingLease) {
                await this.options.storage.releaseSessionLease(session, existing.lease_holder_connection_id, now);
                const reacquired = await this.options.storage.acquireSessionLease(session, connectionId, now, leaseOwner);
                if (!reacquired) {
                    await this.ensureCommsBestEffort(project);
                    return { ok: false, reason: "same-project codex session lease already held" };
                }
            }
            else if (existing?.lease_holder_connection_id) {
                await this.ensureCommsBestEffort(project);
                return {
                    ok: true,
                    reason: "codex session lease already held; registration refreshed",
                    capabilities: this.adapter.capabilities,
                };
            }
            else {
                await this.ensureCommsBestEffort(project);
                return { ok: false, reason: "same-project codex session lease already held" };
            }
        }
        const control = new BridgeControlChannel();
        await this.adapter.connect(session, control);
        if (typeof params.app_server_url === "string") {
            this.adapter.setAppServerUrl(session, params.app_server_url);
        }
        this.trackSession(project, session);
        // AGE-38/AGE-45: after connect + trackSession so inbound cannot race ahead of setup.
        await this.ensureCommsBestEffort(project);
        const persistAfterDisconnect = params.persist_after_disconnect === true;
        const manageAppServerLifecycle = params.manage_app_server_lifecycle === true ||
            params.source === "mcp-server";
        const lease = {
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
            if (persistAfterDisconnect)
                return;
            void this.releaseSessionLease(lease);
        };
        socket?.once("close", release);
        return { ok: true, capabilities: this.adapter.capabilities };
    }
    async drainInbound(params) {
        const session = typeof params.session === "string" ? params.session : undefined;
        // The pending-inbound queue is daemon-wide and shared with other
        // bridges (e.g. ClaudeBridge). Drain only entries whose source
        // `(comm, account)` belongs to a Codex registration; otherwise a
        // draining bridge sweeps the queue and starves its siblings. We use
        // `message.chat.account` (the bot_user_id, the source-of-truth field)
        // rather than the derived `conversation.agent`.
        const owned = await this.ownedAccountKeys(session);
        const drained = this.options.pendingInbound.filter((entry) => owned.has(accountKey(entry)));
        if (drained.length > 0) {
            await removePendingInboundEntries(this.options.storage, this.options.pendingInbound, drained);
        }
        if (session && drained.length > 0) {
            await this.options.storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id);
        }
        return drained;
    }
    async openQuery(params) {
        const session = requiredString(params.session, "session");
        const queryInput = recordOrEmpty(params.query);
        const promptText = requiredString(params.prompt_text ?? queryInput.prompt_text, "prompt_text");
        const queryId = `q_${crypto.randomUUID()}`;
        const sessionRecord = await this.options.storage.getSession(session);
        const conversation = sessionRecord?.most_recent_inbound_conversation_id
            ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
            : null;
        const originChat = conversation ? await this.chatRefForConversation(conversation) : undefined;
        if (!originChat) {
            const hookResponse = codexHookDecision("deny", `No recent inbound Telegram conversation is associated with Codex session ${session}.`);
            return {
                query_id: queryId,
                hook_response: hookResponse,
                hookJson: hookResponse,
                nativeHookJson: hookResponse,
            };
        }
        const query = {
            schema_version: 1,
            query_id: queryId,
            agent: this.agentId,
            session,
            kind: "approval",
            prompt_text: promptText,
            origin_chat: originChat,
            created_at: Date.now(),
            ttl_seconds: typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS,
        };
        // AGE-9: same caller-chosen supersede policy as ClaudeBridge.openQuery.
        const supersede = params.supersede !== false;
        if (supersede) {
            await this.options.storage.supersedeOpenQueriesForSession(session, Date.now());
        }
        const resolutionPromise = this.waitForResolution(queryId, query.ttl_seconds);
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
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to record prompt message id for ${queryId}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
        const decision = await resolutionPromise;
        const hookResponse = codexDecisionFromResolution(decision);
        return {
            query_id: queryId,
            hook_response: hookResponse,
            hookJson: hookResponse,
            nativeHookJson: hookResponse,
        };
    }
    async turnControl(params) {
        const session = requiredString(params.session, "session");
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
    async handleCommCallback(comm, event) {
        const parsed = parseCallbackData(event.data);
        if (!parsed)
            return;
        const openQuery = await this.options.storage.getOpenQueryById(parsed.queryId);
        if (!openQuery || openQuery.agent !== this.agentId) {
            return;
        }
        const chat = {
            comm: comm.id,
            account: "",
            chat_native_id: event.chat_native_id,
        };
        const outcome = await this.options.bus.resolveQueryFromCallback({
            queryId: parsed.queryId,
            value: parsed.value,
            fromId: event.from_id,
            chat,
        });
        if (!comm.answerCallback)
            return;
        if (outcome.kind === "resolved") {
            await comm.answerCallback(event.callback_id, { text: ackTextFor(outcome.decision) });
            if (comm.editMessage) {
                try {
                    await comm.editMessage(event.chat_native_id, event.message_native_id, `Resolved via Telegram (${ackTextFor(outcome.decision)}).`);
                }
                catch {
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
    waitForResolution(queryId, ttlSeconds) {
        const timeoutMs = Math.min(this.options.queryPollTimeoutMs ?? DEFAULT_QUERY_POLL_TIMEOUT_MS, Math.max(1, ttlSeconds) * 1000);
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
    async ensureCommsBestEffort(project) {
        try {
            await this.options.ensureCommsForSession?.(project, this.agentId);
        }
        catch (error) {
            console.error(`agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    trackSession(project, session) {
        const sessions = this.sessionsByProject.get(project) ?? new Set();
        sessions.add(session);
        this.sessionsByProject.set(project, sessions);
    }
    untrackSession(project, session) {
        const sessions = this.sessionsByProject.get(project);
        if (!sessions)
            return;
        sessions.delete(session);
        if (sessions.size === 0)
            this.sessionsByProject.delete(project);
    }
    async releaseSessionLease(input) {
        if (input.released)
            return;
        input.released = true;
        try {
            this.untrackSession(input.project, input.session);
            const active = this.activeLeases.get(input.session);
            if (active?.connectionId === input.connectionId) {
                this.activeLeases.delete(input.session);
            }
            await this.adapter.disconnect(input.session);
            await this.options.storage.releaseSessionLease(input.session, input.connectionId, Date.now());
            input.control.close();
            if (input.manageAppServerLifecycle) {
                this.scheduleManagedAppServerCleanup(input.session);
            }
            this.stopOwnerCheckTimerIfIdle();
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to release Codex session ${input.session}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    ensureOwnerCheckTimer() {
        if (this.ownerCheckTimer || this.activeLeases.size === 0)
            return;
        const interval = this.options.sessionOwnerCheckIntervalMs ?? DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS;
        this.ownerCheckTimer = setInterval(() => {
            void this.releaseLeasesWithDeadOwners();
        }, interval);
        this.ownerCheckTimer.unref?.();
    }
    stopOwnerCheckTimerIfIdle() {
        if (!this.ownerCheckTimer || this.activeLeases.size > 0)
            return;
        clearInterval(this.ownerCheckTimer);
        this.ownerCheckTimer = null;
    }
    async releaseLeasesWithDeadOwners() {
        for (const lease of [...this.activeLeases.values()]) {
            const record = await this.options.storage.getSession(lease.session);
            if (record?.lease_holder_connection_id !== lease.connectionId)
                continue;
            const ownerPid = record.lease_owner_process_pid;
            if (!ownerPid)
                continue;
            const isAlive = this.options.isProcessAlive ?? isPidAlive;
            if (isAlive(ownerPid))
                continue;
            await this.releaseSessionLease(lease);
        }
    }
    scheduleManagedAppServerCleanup(session) {
        const delay = this.options.appServerCleanupDelayMs ?? DEFAULT_APP_SERVER_CLEANUP_DELAY_MS;
        const timer = setTimeout(() => {
            void this.cleanupManagedAppServerIfLeaseIsIdle(session);
        }, delay);
        timer.unref?.();
    }
    async cleanupManagedAppServerIfLeaseIsIdle(session) {
        try {
            const record = await this.options.storage.getSession(session);
            if (record?.lease_holder_connection_id)
                return;
            await cleanupManagedCodexAppServer(session);
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to cleanup Codex app-server for ${session}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async chatRefForConversation(conversation) {
        if (conversation.bot_user_id) {
            return {
                comm: conversation.comm,
                account: conversation.bot_user_id,
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
        const registration = registrations.find((candidate) => candidate.registration_id === conversation.registration_id);
        if (!registration)
            return undefined;
        return {
            comm: conversation.comm,
            account: registration.bot_user_id,
            chat_native_id: conversation.chat_native_id,
            thread_native_id: conversation.thread_native_id ?? undefined,
        };
    }
    async auditWake(kind, conversation, session, detail) {
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
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to audit Codex wake event for ${conversation.conversation_id}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async pendingInboundForConversation(conversation) {
        const owned = await this.ownedAccountKeys();
        return this.options.pendingInbound.filter((entry) => owned.has(accountKey(entry)) &&
            entry.conversation.project === conversation.project);
    }
    /**
     * Cache the set of `${comm}:${bot_user_id}` keys this agent owns. See
     * the matching comment in `ClaudeBridge` for the caching contract.
     */
    async ownedAccountKeys(session) {
        // AGE-38: scope to the calling session's (project, agent), not agent-wide
        // (see ClaudeBridge for the rationale). The wake path
        // (`pendingInboundForConversation`) still calls this with no session and
        // applies its own `conversation.project` filter, so agent-wide is correct
        // there. Unknown session → empty Set (don't bleed). No session → agent-wide
        // (cached).
        if (session) {
            const sess = await this.options.storage.getSession(session);
            if (!sess)
                return new Set();
            const scoped = await this.options.storage.listAccountRegistrations({
                project: sess.project,
                agent: this.agentId,
            });
            return new Set(scoped.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
        }
        if (this.ownedAccountsCache)
            return this.ownedAccountsCache;
        const registrations = await this.options.storage.listAccountRegistrations({
            agent: this.agentId,
        });
        this.ownedAccountsCache = new Set(registrations.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
        return this.ownedAccountsCache;
    }
    async removePendingInbound(entries) {
        if (entries.length === 0)
            return;
        // Scope removal by durable delivery key (message_id + comm + account) so
        // we only remove Codex-owned entries. The same Telegram message can
        // appear in pendingInbound twice when multiple bots in the same chat each
        // receive the update.
        const owned = await this.ownedAccountKeys();
        const scoped = entries.filter((entry) => owned.has(accountKey(entry)));
        await removePendingInboundEntries(this.options.storage, this.options.pendingInbound, scoped);
    }
}
function accountKey(entry) {
    return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
function formatInboundMessagesForTurn(entries) {
    if (entries.length === 0) {
        return "Check for pending daemon-delivered Telegram messages and handle them if present.";
    }
    const lines = entries.map((entry) => {
        const message = entry.message;
        const conversation = entry.conversation;
        const sender = message.sender.display_name ?? message.sender.id ?? "unknown sender";
        const textParts = [];
        if (message.text)
            textParts.push(message.text);
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
        "Process these daemon-delivered Telegram messages as user input. If a reply is requested, use the Telegram MCP tool.",
        "[Daemon Inbound Messages]",
        ...lines,
        "[End Daemon Inbound Messages]",
    ].join("\n");
}
function formatAttachmentForCodex(attachment) {
    const fields = [
        attachment.local_path ? `path=${JSON.stringify(attachment.local_path)}` : null,
        attachment.filename ? `filename=${JSON.stringify(attachment.filename)}` : null,
        attachment.mime ? `mime=${JSON.stringify(attachment.mime)}` : null,
        typeof attachment.size === "number" ? `size=${attachment.size}` : null,
        attachment.blob_hash ? `blob_hash=${attachment.blob_hash}` : null,
    ].filter(Boolean);
    return `[Attachment: ${fields.join(" ") || "attachment"}]`;
}
function inlineKeyboardForQuery(queryId) {
    return [
        [
            { text: "Allow", callback_data: `q:${queryId}:y` },
            { text: "Deny", callback_data: `q:${queryId}:n` },
        ],
        [{ text: "Always", callback_data: `q:${queryId}:a` }],
    ];
}
function parseCallbackData(data) {
    if (!data.startsWith("q:"))
        return null;
    const rest = data.slice(2);
    const sep = rest.lastIndexOf(":");
    if (sep <= 0)
        return null;
    const queryId = rest.slice(0, sep);
    const value = rest.slice(sep + 1);
    if (!queryId || !value)
        return null;
    return { queryId, value };
}
function ackTextFor(decision) {
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
function requiredString(paramsValue, name) {
    if (typeof paramsValue !== "string" || paramsValue.length === 0) {
        throw new Error(`${name} is required`);
    }
    return paramsValue;
}
function recordOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function sessionLeaseOwnerFromParams(params, fallbackLabel) {
    const pid = numberParam(params.owner_process_pid);
    if (!pid)
        return undefined;
    return {
        process_pid: pid,
        process_label: typeof params.owner_process_label === "string"
            ? params.owner_process_label
            : fallbackLabel,
    };
}
function numberParam(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return null;
    }
    return value;
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
class BridgeControlChannel {
    closeHandler = null;
    onClose(handler) {
        this.closeHandler = handler;
    }
    async send(_envelope) {
        // Bridge-local adapter control frames are diagnostic only for now.
    }
    close() {
        this.closeHandler?.();
    }
}
export class CodexBridgeFactory {
    agentId = "codex";
    create(context) {
        return new CodexBridge({
            storage: context.storage,
            bus: context.bus,
            audit: context.audit,
            pendingInbound: context.pendingInbound,
            ensureCommsForSession: context.ensureCommsForSession,
        });
    }
}
//# sourceMappingURL=bridge.js.map
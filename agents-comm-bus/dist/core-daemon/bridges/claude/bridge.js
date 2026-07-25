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
import { SCHEMA_VERSION_SESSION, } from "agents-comm-bus-core";
import { sessionLeaseOwnerWithDaemon } from "../../runtime/agent-bridge.js";
import { normalizeProjectPath } from "../../project-path.js";
import { accountLabelScopeFromParams, filterRegistrationsForSession, } from "../../session-label-scope.js";
import { removePendingInboundEntries } from "../../runtime/durable-inbound.js";
import { ClaudeWakeRegistry } from "./wake.js";
import { ClaudeOpenQueryTracker } from "./open-query-tracker.js";
import { createSessionOwnerLiveness, } from "../../runtime/session-owner-liveness.js";
const DEFAULT_TTL_SECONDS = 3600;
const CLAUDE_IPC_METHODS = new Set([
    "claude_register_session",
    "claude_drain_inbound",
    "claude_open_query",
]);
export class ClaudeBridge {
    options;
    agentId = "claude";
    ipcMethods = CLAUDE_IPC_METHODS;
    wake;
    ownedAccountsCache = null;
    /** AGE-37: sequential AskUserQuestion prompts keyed by the active query id. */
    questionSequences = new Map();
    /** AGE-36: daemon-local open-query tracking for retirement eligibility. */
    openQueryTracker;
    sessionOwnerIsLive;
    constructor(options) {
        this.options = options;
        // pendingInboundMax preserved as an option for symmetry but the daemon
        // now caps the shared queue itself; this class only drains it.
        void options.pendingInboundMax;
        this.sessionOwnerIsLive =
            options.sessionOwnerIsLive ?? createSessionOwnerLiveness();
        this.wake = new ClaudeWakeRegistry(Date.now, this.sessionOwnerIsLive);
        this.wake.setStorage(options.storage);
        this.openQueryTracker = new ClaudeOpenQueryTracker({
            setTimeoutFn: options.setTimeoutFn,
            clearTimeoutFn: options.clearTimeoutFn,
        });
    }
    /**
     * Wire Claude-specific behaviors into the bus + per-comm callbacks. The
     * shared dispatch sink (pendingInbound + onInboundConversation fan-out)
     * is set up by the daemon; here we only own resolve-on-sink (write the
     * wake response) and the inline-keyboard callback handler.
     */
    attach(comms) {
        this.options.bus.setResolveSink({
            onResolved: async (query, decision) => {
                if (query.agent !== this.agentId)
                    return;
                // Resolution is authoritative for retirement eligibility. Clear the
                // daemon-local blocker before any wake I/O or sequencer step can fail;
                // a resolved query must never keep this daemon alive until its TTL.
                this.openQueryTracker.clearOpenQuery(query.query_id);
                const payload = wakePayloadFromDecision(decision);
                if (!payload)
                    return;
                try {
                    const delivered = await this.wake.writeResponseForSession(query.session, payload);
                    if (!delivered) {
                        await this.auditWakeFailure({
                            reason: "hydration_miss",
                            session: query.session,
                            detail: { path: "resolve_sink", prompt_type: payload.prompt_type },
                        });
                    }
                }
                catch (error) {
                    await this.auditWakeFailure({
                        reason: "write_failed",
                        session: query.session,
                        detail: {
                            path: "resolve_sink",
                            prompt_type: payload.prompt_type,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    });
                }
                // AGE-37: advance the AskUserQuestion sequencer when this query resolves.
                const seq = this.questionSequences.get(query.query_id);
                if (seq) {
                    this.questionSequences.delete(query.query_id);
                    await this.openNextQuestion(seq);
                }
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
        // ClaudeBridge keeps no per-adapter state beyond the onCallback handler,
        // which is owned by the adapter and discarded when the adapter stops.
    }
    getRetirementBlockers() {
        return this.openQueryTracker.getRetirementBlockers();
    }
    invalidateRegistrationCaches() {
        this.ownedAccountsCache = null;
    }
    async onInboundConversation(conversation, message) {
        if (conversation.agent !== this.agentId)
            return;
        try {
            const delivered = await this.wake.wakeConversation(conversation, message);
            if (!delivered) {
                await this.auditWakeFailure({
                    reason: "hydration_miss",
                    conversation_id: conversation.conversation_id,
                    detail: { path: "inbound_wake", project: conversation.project },
                });
            }
        }
        catch (error) {
            console.error(`agents-comm-bus: failed to write Claude wake trigger for ` +
                `${conversation.conversation_id}: ${error instanceof Error ? error.message : String(error)}`);
            await this.auditWakeFailure({
                reason: "write_failed",
                conversation_id: conversation.conversation_id,
                detail: {
                    path: "inbound_wake",
                    project: conversation.project,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    async auditWakeFailure(input) {
        try {
            await this.options.audit?.append({
                timestamp: Date.now(),
                kind: "wake_delivery_failure",
                agent: this.agentId,
                session: input.session,
                conversation_id: input.conversation_id,
                detail: { reason: input.reason, ...input.detail },
            });
        }
        catch {
            // best-effort observability
        }
    }
    async handleIpcMethod(method, params, ctx) {
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
    async drainPendingInbound(session) {
        const owned = await this.ownedAccountKeys(session);
        const drained = this.options.pendingInbound.filter((entry) => owned.has(accountKey(entry)));
        if (drained.length > 0) {
            await removePendingInboundEntries(this.options.storage, this.options.pendingInbound, drained);
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
    async ensureCommsBestEffort(project, accountLabelScope) {
        try {
            await this.options.ensureCommsForSession?.(project, this.agentId, {
                accountLabelScope: accountLabelScope ?? null,
            });
        }
        catch (error) {
            console.error(`agents-comm-bus: ensureCommsForSession failed for ${project}/${this.agentId}: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async ownedAccountKeys(session) {
        // AGE-38: scope to the calling session's (project, agent), not agent-wide.
        // A daemon can serve live Claude sessions for multiple projects (distinct
        // bots, all instantiated under lazy loading), and an agent-wide scope would
        // let one project's drain sweep another project's pending inbound. Unknown
        // session → empty Set (don't bleed). No session is the legacy/defensive
        // path → agent-wide (cached, since registrations only change via the CLI).
        if (session) {
            const sess = await this.options.storage.getSession(session);
            if (!sess)
                return new Set();
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
            const scoped = filterRegistrationsForSession(registrations, sess, sessions, this.sessionOwnerIsLive);
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
    async registerSession(params, socket) {
        const session = requiredString(params.session, "session");
        const project = normalizeProjectPath(requiredString(params.project, "project"));
        const connectionId = typeof params.connection_id === "string"
            ? params.connection_id
            : `claude:${session}:${crypto.randomUUID()}`;
        const now = Date.now();
        const wakeDir = typeof params.wake_dir === "string"
            ? params.wake_dir
            : typeof params.wakeDir === "string"
                ? params.wakeDir
                : undefined;
        const accountLabelScope = accountLabelScopeFromParams(params);
        await this.options.storage.upsertSession({
            schema_version: SCHEMA_VERSION_SESSION,
            session_id: session,
            agent: "claude",
            project,
            created_at: now,
            lease_holder_connection_id: null,
            lease_acquired_at: null,
            lease_released_at: null,
            lease_owner_process_pid: null,
            lease_owner_process_label: null,
            lease_owner_process_registered_at: null,
            lease_owner_daemon_discovery_root: null,
            lease_owner_daemon_checkout_root: null,
            lease_owner_daemon_state_root: null,
            lease_owner_daemon_bin: null,
            lease_owner_daemon_authority_rank: null,
            most_recent_inbound_conversation_id: null,
            account_label_scope: accountLabelScope,
            status: "active",
        });
        const acquired = await this.options.storage.acquireSessionLease(session, connectionId, now, this.options.daemonOwner
            ? sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params), this.options.daemonOwner)
            : sessionLeaseOwnerFromParams(params));
        if (!acquired) {
            await this.ensureCommsBestEffort(project, accountLabelScope);
            return { ok: false, reason: "same-project claude session lease already held" };
        }
        const registration = this.wake.register({
            session,
            project,
            wakeDir,
            account_label_scope: accountLabelScope,
        });
        socket?.once("close", () => {
            void this.options.storage.releaseSessionConnectionLeasePreservingOwner(session, connectionId, Date.now());
        });
        // AGE-38/AGE-45: after wake registration + close handler so inbound cannot race ahead.
        await this.ensureCommsBestEffort(project, accountLabelScope);
        return { ok: true, wake_dir: registration.wakeDir };
    }
    async drainInbound(params) {
        const session = typeof params.session === "string" ? params.session : undefined;
        const drained = await this.drainPendingInbound(session);
        if (session && drained.length > 0) {
            await this.options.storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id);
        }
        return drained;
    }
    async openQuery(params) {
        const session = requiredString(params.session, "session");
        const queryInput = recordOrEmpty(params.query);
        const claudeInput = recordOrEmpty(params.claude);
        const toolName = typeof params.tool_name === "string"
            ? params.tool_name
            : typeof claudeInput.tool_name === "string"
                ? claudeInput.tool_name
                : undefined;
        const promptText = requiredString(params.prompt_text ?? queryInput.prompt_text, "prompt_text");
        const rawKind = params.kind ?? queryInput.kind;
        const kind = rawKind === "choice" || rawKind === "freetext" || rawKind === "approval"
            ? rawKind
            : "approval";
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
        const ttlSeconds = typeof params.ttl_seconds === "number" ? params.ttl_seconds : DEFAULT_TTL_SECONDS;
        const promptFormatRaw = params.prompt_format ?? queryInput.prompt_format;
        const promptFormat = promptFormatRaw === "html" ? "html" : "plain";
        // AGE-9: callers choose supersede-vs-coexist. Hook-driven paths keep the
        // default (true) — Claude's local UI is exclusive, so a new local prompt
        // always moots the prior one. Deliberate multi-open callers (the AGE-37
        // question sequencer, future fan-out flows) pass supersede=false.
        const supersede = params.supersede !== false;
        // AGE-37: multi-question AskUserQuestion → show one question at a time.
        const questions = parseNormalizedQuestions(params.questions ?? queryInput.questions);
        if (questions && questions.length > 1) {
            const firstQuestion = questions[0];
            const sequencedPrompt = formatQuestionPrompt(firstQuestion, 0, questions.length);
            const sequencedOptions = questionOptionsFromNormalized(firstQuestion);
            const queryId = await this.openQueryCore({
                session,
                kind: "choice",
                promptText: sequencedPrompt,
                promptFormat: "html",
                options: sequencedOptions,
                originChat,
                ttlSeconds,
                supersede,
            });
            this.questionSequences.set(queryId, {
                session,
                questions,
                index: 0,
                ttlSeconds,
            });
            const hookResponse = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
            return {
                query_id: queryId,
                hook_response: hookResponse,
                hookJson: hookResponse,
                nativeHookJson: hookResponse,
            };
        }
        const queryId = await this.openQueryCore({
            session,
            kind,
            promptText,
            promptFormat,
            options,
            originChat,
            ttlSeconds,
            supersede,
        });
        const hookResponse = hookResponseForUnresolvedClaudeQuery({ ...params, tool_name: toolName });
        return {
            query_id: queryId,
            hook_response: hookResponse,
            hookJson: hookResponse,
            nativeHookJson: hookResponse,
        };
    }
    /**
     * Shared open-query path: build → supersede? → bus.openQuery → send →
     * setQuerySourceMessage. Used by the IPC handler and the AGE-37 sequencer.
     */
    async openQueryCore(input) {
        const queryId = `q_${crypto.randomUUID()}`;
        const query = {
            schema_version: 1,
            query_id: queryId,
            agent: "claude",
            session: input.session,
            kind: input.kind,
            prompt_text: input.promptText,
            options: input.options,
            origin_chat: input.originChat,
            created_at: Date.now(),
            ttl_seconds: input.ttlSeconds,
        };
        if (input.supersede) {
            await this.options.storage.supersedeOpenQueriesForSession(input.session, Date.now());
            // AGE-37: the in-memory sequence map mirrors storage open-state, so a
            // supersede must also drop the session's stale sequences — ANY
            // supersede=true open (a plain permission prompt included), not just a
            // new AskUserQuestion. openNextQuestion passes supersede=false, so a
            // sequence never clears itself mid-flight.
            this.clearQuestionSequencesForSession(input.session);
            this.openQueryTracker.clearOpenQueriesForSession(input.session);
        }
        await this.options.bus.openQuery(query);
        this.openQueryTracker.trackOpenQuery(input.session, queryId, input.ttlSeconds);
        if (input.originChat) {
            try {
                const inlineKeyboard = inlineKeyboardForQuery(queryId, input.kind, input.options);
                const promptMessageId = await this.options.bus.send({
                    session: input.session,
                    comm: input.originChat.comm,
                    target: input.originChat,
                    payload: {
                        text: input.promptText,
                        format: input.promptFormat === "html" ? "html" : "plain",
                        inline_keyboard: inlineKeyboard,
                    },
                    idempotencyKey: `query:${queryId}`,
                });
                // AGE-9: record the prompt's message id so a comm reply that replies-to
                // this exact message resolves THIS query (activates the long-dormant
                // matchReplyToQuery rule). Best-effort — on failure the query stays
                // resolvable via buttons and bare replies.
                try {
                    await this.options.storage.setQuerySourceMessage(queryId, promptMessageId);
                }
                catch (error) {
                    console.error(`agents-comm-bus: failed to record prompt message id for ${queryId}: ` +
                        `${error instanceof Error ? error.message : String(error)}`);
                }
            }
            catch (error) {
                // AGE-37: the prompt never reached the user, so the just-inserted row
                // must not stay open — with multi-open queries (migration 009) an
                // open-but-never-seen query could capture bare-digit replies meant
                // for visible prompts. Roll it back, then rethrow for the caller's
                // retry/fallback path.
                try {
                    await this.options.storage.cancelOpenQuery(queryId, Date.now());
                }
                catch (cancelError) {
                    console.error(`agents-comm-bus: failed to cancel unsent query ${queryId}: ` +
                        `${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
                }
                this.openQueryTracker.clearOpenQuery(queryId);
                throw error;
            }
        }
        return queryId;
    }
    /** Drop stale sequencer entries when any supersede=true open fires. */
    clearQuestionSequencesForSession(session) {
        for (const [queryId, seq] of this.questionSequences) {
            if (seq.session === session) {
                this.questionSequences.delete(queryId);
            }
        }
    }
    /** Open the next question in an AskUserQuestion sequence after resolution. */
    async openNextQuestion(seq) {
        const nextIndex = seq.index + 1;
        if (nextIndex >= seq.questions.length)
            return;
        const sessionRecord = await this.options.storage.getSession(seq.session);
        const conversation = sessionRecord?.most_recent_inbound_conversation_id
            ? await this.options.storage.getConversation(sessionRecord.most_recent_inbound_conversation_id)
            : null;
        const originChat = conversation ? await this.chatRefForConversation(conversation) : undefined;
        const nextQuestion = seq.questions[nextIndex];
        const promptText = formatQuestionPrompt(nextQuestion, nextIndex, seq.questions.length);
        const options = questionOptionsFromNormalized(nextQuestion);
        const attemptOpen = async () => this.openQueryCore({
            session: seq.session,
            kind: "choice",
            promptText,
            promptFormat: "html",
            options,
            originChat,
            ttlSeconds: seq.ttlSeconds,
            supersede: false,
        });
        try {
            const queryId = await attemptOpen();
            this.questionSequences.set(queryId, { ...seq, index: nextIndex });
        }
        catch (firstError) {
            try {
                const queryId = await attemptOpen();
                this.questionSequences.set(queryId, { ...seq, index: nextIndex });
            }
            catch (secondError) {
                console.error(`agents-comm-bus: failed to open AskUserQuestion ${nextIndex + 1}/${seq.questions.length} ` +
                    `for session ${seq.session}: ` +
                    `${secondError instanceof Error ? secondError.message : String(secondError)} ` +
                    `(retry after: ${firstError instanceof Error ? firstError.message : String(firstError)})`);
                if (originChat) {
                    try {
                        await this.options.bus.send({
                            session: seq.session,
                            comm: originChat.comm,
                            target: originChat,
                            payload: {
                                text: `⚠️ Couldn't post question ${nextIndex + 1}/${seq.questions.length} ` +
                                    `— answer the remaining questions locally; this sequence is cancelled.`,
                                format: "plain",
                            },
                            idempotencyKey: `query-seq-fail:${seq.session}:${nextIndex}:${Date.now()}`,
                        });
                    }
                    catch {
                        // Best-effort fallback; sequence is already dropped.
                    }
                }
            }
        }
    }
    async handleCommCallback(comm, event) {
        const parsed = parseCallbackData(event.data);
        if (!parsed) {
            if (comm.answerCallback) {
                await comm.answerCallback(event.callback_id, {
                    text: "Unrecognized button payload",
                });
            }
            return;
        }
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
        switch (outcome.kind) {
            case "resolved": {
                const text = ackTextFor(outcome.decision);
                await comm.answerCallback(event.callback_id, { text });
                if (comm.editMessage) {
                    try {
                        await comm.editMessage(event.chat_native_id, event.message_native_id, `✓ Resolved via Telegram (${text}).`);
                    }
                    catch {
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
                        await comm.editMessage(event.chat_native_id, event.message_native_id, "💬 Awaiting your custom reply… (send any text in this chat).");
                    }
                    catch {
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
}
function accountKey(entry) {
    return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
function inlineKeyboardForQuery(queryId, kind, options) {
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
        const rows = (options ?? []).map((label, index) => [
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
function truncateButtonText(label) {
    const trimmed = label.replace(/\s+/g, " ").trim();
    if (trimmed.length <= 48)
        return trimmed;
    return `${trimmed.slice(0, 47)}…`;
}
function wakePayloadFromDecision(decision) {
    switch (decision.decision) {
        case "allow":
            return { response: "y", prompt_type: "permission" };
        case "deny":
            return { response: "n", prompt_type: "permission" };
        case "always_allow":
            return { response: "a", prompt_type: "permission" };
        case "select_option": {
            const idx = decision.selected_option_index;
            if (typeof idx !== "number")
                return null;
            return { response: String(idx + 1), prompt_type: "question" };
        }
        case "text":
            if (!decision.text)
                return null;
            return { response: decision.text, prompt_type: "freetext" };
        default:
            return null;
    }
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
function hookResponseForUnresolvedClaudeQuery(params) {
    if (params.tool_name === "AskUserQuestion") {
        return { decision: { behavior: "allow" } };
    }
    return { decision: { behavior: "ask" } };
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
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
/** Defensively parse the hook's `questions` array; malformed input → null. */
function parseNormalizedQuestions(value) {
    if (!Array.isArray(value) || value.length === 0)
        return null;
    const parsed = [];
    for (const entry of value.slice(0, 8)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return null;
        const record = entry;
        if (typeof record.question !== "string" || !Array.isArray(record.options))
            return null;
        const options = [];
        for (const opt of record.options) {
            if (!opt || typeof opt !== "object" || Array.isArray(opt))
                return null;
            const optRecord = opt;
            if (typeof optRecord.label !== "string")
                return null;
            options.push({
                label: optRecord.label,
                description: typeof optRecord.description === "string"
                    ? optRecord.description
                    : undefined,
            });
        }
        parsed.push({
            question: record.question,
            header: typeof record.header === "string" ? record.header : undefined,
            multiSelect: Boolean(record.multiSelect),
            options,
        });
    }
    return parsed.length > 0 ? parsed : null;
}
/** Mirror the hook's questionOptions() for one normalized question. */
function questionOptionsFromNormalized(q) {
    return q.options.map((option) => {
        const description = option.description ? ` - ${option.description}` : "";
        return `${option.label}${description}`;
    });
}
/** Format ONE AskUserQuestion entry for Telegram (daemon-side sequencer). */
function formatQuestionPrompt(q, index, total) {
    let message = `❓ <b>Question ${index + 1}/${total}:</b> ${escapeHtml(q.question)}\n`;
    const options = q.options;
    for (let i = 0; i < options.length; i += 1) {
        const opt = options[i];
        message += `\n<b>${i + 1}.</b> ${escapeHtml(opt.label)}`;
        if (opt.description) {
            message += `\n    <i>${escapeHtml(opt.description)}</i>`;
        }
    }
    message += `\n<b>${options.length + 1}.</b> Other (custom text)`;
    if (q.multiSelect) {
        message += `\n\n<i>(Multi-select: reply with comma-separated numbers)</i>`;
    }
    message += `\n\nReply with <b>number</b> to select`;
    return message;
}
function sessionLeaseOwnerFromParams(params) {
    const pid = numberParam(params.owner_process_pid);
    if (!pid)
        return undefined;
    return {
        process_pid: pid,
        process_label: typeof params.owner_process_label === "string"
            ? params.owner_process_label
            : "claude",
    };
}
function numberParam(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return null;
    }
    return value;
}
export class ClaudeBridgeFactory {
    agentId = "claude";
    create(context) {
        return new ClaudeBridge({
            storage: context.storage,
            bus: context.bus,
            audit: context.audit,
            pendingInbound: context.pendingInbound,
            ensureCommsForSession: context.ensureCommsForSession,
            daemonOwner: context.daemonOwner,
            sessionOwnerIsLive: context.sessionOwnerIsLive,
        });
    }
}
//# sourceMappingURL=bridge.js.map
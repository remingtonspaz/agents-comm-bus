import crypto from "node:crypto";
import { SCHEMA_VERSION_CONVERSATION, SCHEMA_VERSION_QUERY, assertHasOrigin, isForeignBotAllowed, RecentSeenCache, tryResolve, } from "agents-comm-bus-core";
export class MessageBus {
    options;
    /**
     * Adapter map keyed by `${commId}:${accountId}` so multiple bots can share
     * `comm.id` (e.g. one Telegram adapter per agent, each bound to a different
     * `bot_user_id`). `bus.send` resolves `target.account` by concrete bot id
     * only; account labels are display metadata and are rejected as send targets.
     */
    comms = new Map();
    seen = new RecentSeenCache();
    now;
    dispatchSink = null;
    resolveSinks = [];
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        for (const comm of options.comms ?? []) {
            this.registerComm(comm);
        }
    }
    registerComm(comm) {
        const key = adapterKey(comm.id, comm.accountId);
        const existing = this.comms.get(key);
        if (existing && existing !== comm) {
            throw new Error(`agents-comm-bus: a comm adapter is already registered for ${key}; ` +
                `each (commId, accountId) pair must be unique`);
        }
        this.comms.set(key, comm);
        comm.onInbound(async (message) => {
            await this.receiveInbound(message);
        });
        comm.onConnectionState((state) => {
            void this.options.audit.append({
                timestamp: this.now(),
                kind: state === "disconnected" ? "outbound_failed" : "inbound_received",
                detail: { comm: comm.id, account: comm.accountId, connection_state: state },
            });
        });
    }
    /**
     * Detach a comm adapter from the bus map. Does NOT call `comm.stop()` —
     * callers (typically the daemon's reload path) are responsible for the
     * lifecycle so they can sequence stop + detach in the order they want.
     * Returns the removed adapter so the caller can stop it, or null if no
     * adapter was registered for that `(commId, accountId)`.
     */
    unregisterComm(commId, accountId) {
        const key = adapterKey(commId, accountId);
        const adapter = this.comms.get(key);
        if (!adapter)
            return null;
        this.comms.delete(key);
        return adapter;
    }
    /** List the `(commId, accountId)` pairs currently attached to the bus. */
    listComms() {
        return Array.from(this.comms.values()).map((comm) => ({
            commId: comm.id,
            accountId: comm.accountId,
        }));
    }
    /**
     * Look up a currently-attached adapter by `(commId, accountId)`. Used by
     * the daemon's reload path to refresh per-adapter state (e.g. allowlist
     * updates) without tearing down and recreating the adapter.
     */
    getComm(commId, accountId) {
        return this.comms.get(adapterKey(commId, accountId)) ?? null;
    }
    setDispatchSink(sink) {
        this.dispatchSink = sink;
    }
    setResolveSink(sink) {
        this.resolveSinks.push(sink);
    }
    async start() {
        for (const comm of this.comms.values()) {
            await comm.start();
        }
    }
    async stop() {
        for (const comm of this.comms.values()) {
            await comm.stop();
        }
    }
    async receiveInbound(message) {
        assertHasOrigin(message);
        // Scope the seen-key by (comm, account) so the same platform message
        // reaching two different adapters of the same comm (e.g. one Telegram
        // group with two bots, each polled by its own TelegramCommAdapter)
        // counts as two separate inbound events. Without this scoping, the
        // dedupe drops one bot's delivery as "recently seen" and only the
        // first-to-arrive adapter ever sees the message.
        const seenKey = `${message.chat.comm}:${message.chat.account}:${message.message_id}`;
        if (this.seen.seen(seenKey, this.now())) {
            await this.options.audit.append({
                timestamp: this.now(),
                kind: "loop_prevention_drop",
                detail: {
                    message_id: message.message_id,
                    comm: message.chat.comm,
                    account: message.chat.account,
                    reason: "recently_seen",
                },
            });
            throw new Error(`duplicate inbound message: ${seenKey}`);
        }
        this.seen.record(seenKey, this.now());
        const receivingAdapter = this.comms.get(adapterKey(message.chat.comm, message.chat.account));
        const foreignBotPolicy = {
            allowForeignBots: false,
            allowedBotIds: receivingAdapter?.allowedSenderIds,
        };
        if (!isForeignBotAllowed(message.sender, foreignBotPolicy)) {
            await this.options.audit.append({
                timestamp: this.now(),
                kind: "loop_prevention_drop",
                detail: {
                    message_id: message.message_id,
                    reason: "foreign_bot",
                    sender_id: message.sender.id,
                },
            });
            throw new Error(`foreign bot sender rejected: ${message.sender.id}`);
        }
        const registration = await this.registrationFor(message.chat);
        const conversation = await this.upsertConversation(registration, message);
        await this.options.transcripts.append({
            conversation_id: conversation.conversation_id,
            timestamp: message.received_at,
            direction: "inbound",
            message_id: message.message_id,
            payload: message,
        });
        await this.options.storage.touchConversationInbound(conversation.conversation_id, message.received_at, message.message_id);
        await this.options.audit.append({
            timestamp: this.now(),
            kind: "inbound_received",
            agent: registration.agent,
            conversation_id: conversation.conversation_id,
            detail: {
                comm: registration.comm,
                account: message.chat.account,
                account_label: registration.account_label,
                platform_message_id: message.platform_message_id,
            },
        });
        const consumedByQuery = await this.tryResolveOpenQuery(conversation, message);
        if (consumedByQuery)
            return conversation;
        if (this.dispatchSink) {
            await this.dispatchSink.enqueueInbound(message, conversation);
        }
        return conversation;
    }
    async send(request) {
        const target = request.target ?? (await this.targetFromSession(request.session));
        if (target.comm !== request.comm) {
            throw new Error(`target comm ${target.comm} does not match requested comm ${request.comm}`);
        }
        // target.account MUST be a concrete bot_user_id (AGE-15). registrationFor
        // rejects account labels — they are ambiguous across agents.
        const registration = await this.registrationFor(target);
        const comm = this.comms.get(adapterKey(target.comm, registration.bot_user_id));
        if (!comm) {
            throw new Error(`comm adapter not registered: ${target.comm}/${registration.bot_user_id}`);
        }
        const sent = await comm.send(target, request.payload, request.idempotencyKey ?? randomId("outbound"));
        const messageId = makeMessageId(request.comm, sent.platform_message_id);
        const conversation = await this.findConversationForTarget(target);
        await this.options.transcripts.append({
            conversation_id: conversation.conversation_id,
            timestamp: sent.sent_at,
            direction: "outbound",
            message_id: messageId,
            payload: { target, payload: request.payload, platform_message_id: sent.platform_message_id },
        });
        await this.options.storage.touchConversationOutbound(conversation.conversation_id, sent.sent_at, messageId);
        await this.options.audit.append({
            timestamp: this.now(),
            kind: "outbound_sent",
            agent: registration.agent,
            session: request.session,
            conversation_id: conversation.conversation_id,
            // Record the RESOLVED sending account so the audit can confirm which bot
            // a message went out on (AGE-15: this was `account=-`, making the
            // 2026-05-30 misroute undiagnosable from the audit alone). Also keep the
            // caller's original requested account to spot label-vs-id mismatches.
            detail: {
                comm: request.comm,
                platform_message_id: sent.platform_message_id,
                account: registration.bot_user_id,
                account_label: registration.account_label,
                chat_native_id: target.chat_native_id,
                thread_native_id: target.thread_native_id ?? null,
                requested_account: request.target?.account ?? null,
            },
        });
        return messageId;
    }
    async openQuery(query) {
        let originChatId = null;
        if (query.origin_chat) {
            try {
                const registration = await this.registrationFor(query.origin_chat);
                const conversation = await this.options.storage.findConversation({
                    project: registration.project,
                    agent: registration.agent,
                    comm: query.origin_chat.comm,
                    account_label: registration.account_label,
                    bot_user_id: registration.bot_user_id,
                    chat_native_id: query.origin_chat.chat_native_id,
                    thread_native_id: query.origin_chat.thread_native_id ?? null,
                });
                originChatId = conversation?.conversation_id ?? null;
            }
            catch {
                originChatId = null;
            }
        }
        const record = {
            schema_version: SCHEMA_VERSION_QUERY,
            query_id: query.query_id,
            agent: query.agent,
            session: query.session,
            kind: query.kind,
            prompt_text: query.prompt_text,
            created_at: query.created_at,
            ttl_seconds: query.ttl_seconds,
            origin_chat_id: originChatId,
            source_message_id: query.source_message_id ?? null,
            resolved_at: null,
            resolution: null,
            options_json: query.options ? JSON.stringify(query.options) : null,
        };
        await this.options.storage.insertQuery(record);
        await this.options.audit.append({
            timestamp: this.now(),
            kind: "query_opened",
            agent: query.agent,
            session: query.session,
            conversation_id: record.origin_chat_id ?? undefined,
            detail: { query_id: query.query_id, kind: query.kind },
        });
    }
    async tryResolveOpenQuery(conversation, message) {
        const query = await this.options.storage.getOpenQueryByConversation(conversation.conversation_id);
        if (!query || !message.text)
            return false;
        const decision = decisionFromMessage(query, message, chatRefFromConversation(conversation), this.now());
        if (!decision)
            return false;
        return this.resolveQuery(query.query_id, decision);
    }
    async resolveQuery(queryId, decision) {
        const record = await this.options.storage.getQuery(queryId);
        if (!record)
            return false;
        const query = {
            schema_version: record.schema_version,
            query_id: record.query_id,
            agent: record.agent,
            session: record.session,
            kind: record.kind,
            prompt_text: record.prompt_text,
            created_at: record.created_at,
            ttl_seconds: record.ttl_seconds,
            source_message_id: record.source_message_id ?? undefined,
            options: record.options_json ? JSON.parse(record.options_json) : undefined,
            resolution: record.resolution ?? undefined,
        };
        const result = tryResolve(query, decision, this.now());
        if (result.kind === "rejected") {
            await this.options.audit.append({
                timestamp: this.now(),
                kind: result.reason === "expired" ? "query_expired" : "query_rejected_stale",
                agent: record.agent,
                session: record.session,
                detail: { query_id: queryId, reason: result.reason },
            });
            return false;
        }
        const resolved = await this.options.storage.resolveQuery(queryId, decision, decision.decided_at);
        if (resolved) {
            await this.options.audit.append({
                timestamp: this.now(),
                kind: "query_resolved",
                agent: record.agent,
                session: record.session,
                detail: { query_id: queryId, decision: decision.decision },
            });
            await this.notifyResolveSinks(record, decision, queryId);
        }
        return resolved;
    }
    async resolveQueryFromCallback(input) {
        const open = await this.options.storage.getOpenQueryById(input.queryId);
        if (!open) {
            const existing = await this.options.storage.getQuery(input.queryId);
            return { kind: existing ? "already_resolved" : "unknown_query" };
        }
        if (input.value === "other") {
            const ok = await this.options.storage.updateQueryKind(input.queryId, "freetext");
            if (!ok)
                return { kind: "already_resolved" };
            return { kind: "awaiting_freetext", query: open };
        }
        const decision = decisionFromCallbackValue(open, input.value, input.fromId, input.chat, this.now());
        if (!decision)
            return { kind: "invalid_value", value: input.value };
        // Callback resolutions bypass TTL — the user actively responded via the
        // inline keyboard, so "expired" doesn't apply the same way it does for
        // unanswered text-reply windows. Write directly to storage and audit.
        const stored = await this.options.storage.resolveQuery(input.queryId, decision, decision.decided_at);
        if (!stored) {
            // Storage refused — most likely already resolved by another path.
            const post = await this.options.storage.getQuery(input.queryId);
            if (post && post.resolved_at != null)
                return { kind: "already_resolved" };
            return { kind: "expired" };
        }
        await this.options.audit.append({
            timestamp: this.now(),
            kind: "query_resolved",
            agent: open.agent,
            session: open.session,
            detail: { query_id: input.queryId, decision: decision.decision, via: "callback" },
        });
        await this.notifyResolveSinks(open, decision, input.queryId);
        return { kind: "resolved", decision, query: open };
    }
    async listConversations(filter) {
        return this.options.storage.listConversations({
            project: this.options.project,
            comm: filter?.comm,
            limit: filter?.limit,
        });
    }
    /**
     * Resolve a routing target to its registration by the concrete
     * `bot_user_id` ONLY (AGE-15). Account labels (e.g. `"main"`) are human
     * metadata, not durable routing keys: Claude and Codex both register
     * `account_label="main"`, so resolving a label is inherently ambiguous and
     * can surface one agent's outbound on the other's bot (`cbc4a43`, the
     * 2026-05-30 misroute). The prior cross-project label fallback was the bug;
     * it is removed. Every legitimate caller already passes a concrete bot id:
     * inbound carries it from the adapter, session-derived sends resolve it via
     * `targetFromSession`, and `origin_chat` is built by `chatRefForConversation`
     * (which returns `bot_user_id`). A label reaching here now fails loud.
     */
    async registrationFor(chat) {
        const byBot = await this.options.storage.getAccountByBot(chat.comm, String(chat.account));
        if (byBot)
            return byBot;
        throw new Error(`Cannot route to ${chat.comm} account "${chat.account}": not a registered bot id. ` +
            `Routing requires a concrete bot_user_id (shown as account=<id> in your inbound block); ` +
            `account labels like "main" are not accepted as routing targets. ` +
            `Omit target to reply to your most-recent inbound conversation.`);
    }
    async upsertConversation(registration, message) {
        const conversation = {
            schema_version: SCHEMA_VERSION_CONVERSATION,
            project: registration.project,
            comm: registration.comm,
            account_label: registration.account_label,
            bot_user_id: registration.bot_user_id,
            chat_native_id: message.chat.chat_native_id,
            thread_native_id: message.chat.thread_native_id ?? null,
            conversation_id: conversationIdForPk({
                project: registration.project,
                agent: registration.agent,
                comm: registration.comm,
                account_label: registration.account_label,
                chat_native_id: message.chat.chat_native_id,
                thread_native_id: message.chat.thread_native_id ?? null,
            }),
            agent: registration.agent,
            last_inbound_at: message.received_at,
            last_outbound_at: null,
            last_message_id: message.message_id,
            created_at: this.now(),
            metadata: {
                sender_id: message.sender.id,
                sender_display_name: message.sender.display_name,
            },
        };
        await this.options.storage.upsertConversation(conversation);
        return conversation;
    }
    async targetFromSession(session) {
        const record = await this.options.storage.getSession(session);
        const conversationId = record?.most_recent_inbound_conversation_id;
        if (!conversationId) {
            throw new Error(`no explicit target and session ${session} has no most-recent inbound conversation`);
        }
        const conversation = await this.options.storage.getConversation(conversationId);
        if (!conversation)
            throw new Error(`conversation not found: ${conversationId}`);
        const botUserId = await this.botUserIdForConversation(conversation);
        return {
            ...chatRefFromConversation(conversation),
            account: botUserId,
        };
    }
    async findConversationForTarget(target) {
        const registration = await this.registrationFor(target);
        const conversation = await this.options.storage.findConversation({
            project: registration.project,
            agent: registration.agent,
            comm: target.comm,
            account_label: registration.account_label,
            bot_user_id: registration.bot_user_id,
            chat_native_id: target.chat_native_id,
            thread_native_id: target.thread_native_id ?? null,
        });
        if (!conversation) {
            const created = {
                schema_version: SCHEMA_VERSION_CONVERSATION,
                project: registration.project,
                comm: registration.comm,
                account_label: registration.account_label,
                bot_user_id: registration.bot_user_id,
                chat_native_id: target.chat_native_id,
                thread_native_id: target.thread_native_id ?? null,
                conversation_id: conversationIdForPk({
                    project: registration.project,
                    agent: registration.agent,
                    comm: registration.comm,
                    account_label: registration.account_label,
                    chat_native_id: target.chat_native_id,
                    thread_native_id: target.thread_native_id ?? null,
                }),
                agent: registration.agent,
                last_inbound_at: null,
                last_outbound_at: null,
                last_message_id: null,
                created_at: this.now(),
                metadata: { created_from_explicit_target: true },
            };
            await this.options.storage.upsertConversation(created);
            return created;
        }
        return conversation;
    }
    async botUserIdForConversation(conversation) {
        if (conversation.bot_user_id)
            return conversation.bot_user_id;
        const registration = (await this.options.storage.listAccountRegistrations({
            project: conversation.project,
            comm: conversation.comm,
            agent: conversation.agent,
        })).find((candidate) => candidate.account_label === conversation.account_label);
        if (!registration) {
            throw new Error(`no account registration for conversation ${conversation.conversation_id} ` +
                `(${conversation.agent}/${conversation.comm}/${conversation.account_label})`);
        }
        return registration.bot_user_id;
    }
    async notifyResolveSinks(record, decision, queryId) {
        for (const sink of this.resolveSinks) {
            try {
                await sink.onResolved(record, decision);
            }
            catch (error) {
                await this.options.audit.append({
                    timestamp: this.now(),
                    kind: "outbound_failed",
                    agent: record.agent,
                    session: record.session,
                    detail: {
                        query_id: queryId,
                        reason: "resolve_sink_failed",
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
            }
        }
    }
}
export function conversationIdForPk(pk) {
    const raw = JSON.stringify([
        pk.project,
        pk.agent,
        pk.comm,
        pk.account_label,
        pk.chat_native_id,
        pk.thread_native_id ?? "",
    ]);
    return `conv_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}
export function conversationIdForChat(chat) {
    return `conv_${crypto
        .createHash("sha256")
        .update(JSON.stringify([chat.comm, chat.account, chat.chat_native_id, chat.thread_native_id ?? ""]))
        .digest("hex")
        .slice(0, 24)}`;
}
export function chatRefFromConversation(conversation) {
    return {
        comm: conversation.comm,
        // Legacy/null bot_user_id fallback only preserves chat shape for display
        // and query resolution. Send paths must resolve a real bot id first.
        account: (conversation.bot_user_id ?? conversation.account_label),
        chat_native_id: conversation.chat_native_id,
        thread_native_id: conversation.thread_native_id ?? undefined,
    };
}
function makeMessageId(comm, platformMessageId) {
    return `${comm}:${platformMessageId}`;
}
function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}
function decisionFromMessage(query, message, chat, now) {
    const text = message.text?.trim();
    if (!text)
        return null;
    const lower = text.toLowerCase();
    let decision = null;
    let selected_option_index;
    let responseText;
    if (query.kind === "approval") {
        if (["y", "yes", "allow"].includes(lower))
            decision = "allow";
        else if (["n", "no", "deny"].includes(lower))
            decision = "deny";
        else if (["a", "always", "always_allow"].includes(lower))
            decision = "always_allow";
    }
    else if (query.kind === "choice") {
        const choice = Number.parseInt(text, 10);
        if (!Number.isNaN(choice) && choice > 0) {
            decision = "select_option";
            selected_option_index = choice - 1;
        }
    }
    else {
        decision = "text";
        responseText = text;
    }
    if (!decision)
        return null;
    return {
        query_id: query.query_id,
        decision,
        selected_option_index,
        text: responseText,
        decided_by_sender_id: message.sender.id,
        decided_in_chat: chat,
        decided_at: now,
    };
}
function decisionFromCallbackValue(query, value, fromId, chat, now) {
    let decision = null;
    let selected_option_index;
    if (query.kind === "approval") {
        if (value === "y")
            decision = "allow";
        else if (value === "n")
            decision = "deny";
        else if (value === "a")
            decision = "always_allow";
    }
    else if (query.kind === "choice") {
        const choice = Number.parseInt(value, 10);
        if (!Number.isNaN(choice) && choice > 0) {
            decision = "select_option";
            selected_option_index = choice - 1;
        }
    }
    if (!decision)
        return null;
    return {
        query_id: query.query_id,
        decision,
        selected_option_index,
        decided_by_sender_id: fromId,
        decided_in_chat: chat,
        decided_at: now,
    };
}
function adapterKey(commId, accountId) {
    return `${commId}:${accountId}`;
}
//# sourceMappingURL=bus.js.map
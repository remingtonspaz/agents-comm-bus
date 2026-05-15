import crypto from "node:crypto";
import { SCHEMA_VERSION_CONVERSATION, SCHEMA_VERSION_QUERY, assertHasOrigin, isForeignBotAllowed, RecentSeenCache, tryResolve, } from "../../agents-comm-bus-core/dist/index.js";
export class MessageBus {
    options;
    comms = new Map();
    seen = new RecentSeenCache();
    now;
    dispatchSink = null;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        for (const comm of options.comms ?? []) {
            this.registerComm(comm);
        }
    }
    registerComm(comm) {
        this.comms.set(comm.id, comm);
        comm.onInbound(async (message) => {
            await this.receiveInbound(message);
        });
        comm.onConnectionState((state) => {
            void this.options.audit.append({
                timestamp: this.now(),
                kind: state === "disconnected" ? "outbound_failed" : "inbound_received",
                detail: { comm: comm.id, connection_state: state },
            });
        });
    }
    setDispatchSink(sink) {
        this.dispatchSink = sink;
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
        if (this.seen.seen(message.message_id, this.now())) {
            await this.options.audit.append({
                timestamp: this.now(),
                kind: "loop_prevention_drop",
                detail: { message_id: message.message_id, reason: "recently_seen" },
            });
            throw new Error(`duplicate inbound message: ${message.message_id}`);
        }
        this.seen.record(message.message_id, this.now());
        if (!isForeignBotAllowed(message.sender)) {
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
                account_label: registration.account_label,
                platform_message_id: message.platform_message_id,
            },
        });
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
        const comm = this.comms.get(request.comm);
        if (!comm)
            throw new Error(`comm adapter not registered: ${request.comm}`);
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
            conversation_id: conversation.conversation_id,
            detail: { comm: request.comm, platform_message_id: sent.platform_message_id },
        });
        return messageId;
    }
    async openQuery(query) {
        const record = {
            schema_version: SCHEMA_VERSION_QUERY,
            query_id: query.query_id,
            agent: query.agent,
            session: query.session,
            kind: query.kind,
            prompt_text: query.prompt_text,
            created_at: query.created_at,
            ttl_seconds: query.ttl_seconds,
            origin_chat_id: query.origin_chat ? conversationIdForChat(query.origin_chat) : null,
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
        }
        return resolved;
    }
    async listConversations(filter) {
        return this.options.storage.listConversations({
            project: this.options.project,
            comm: filter?.comm,
            limit: filter?.limit,
        });
    }
    async registrationFor(chat) {
        const byBot = await this.options.storage.getAccountByBot(chat.comm, String(chat.account));
        if (byBot)
            return byBot;
        const byLabel = (await this.options.storage.listAccountRegistrations({
            project: this.options.project,
            comm: chat.comm,
        })).find((registration) => registration.account_label === String(chat.account));
        if (!byLabel) {
            throw new Error(`no account registration for ${chat.comm}/${chat.account}`);
        }
        return byLabel;
    }
    async upsertConversation(registration, message) {
        const conversation = {
            schema_version: SCHEMA_VERSION_CONVERSATION,
            project: registration.project,
            comm: registration.comm,
            account_label: registration.account_label,
            chat_native_id: message.chat.chat_native_id,
            thread_native_id: message.chat.thread_native_id ?? null,
            conversation_id: conversationIdForPk({
                project: registration.project,
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
        return chatRefFromConversation(conversation);
    }
    async findConversationForTarget(target) {
        const registration = await this.registrationFor(target);
        const conversation = await this.options.storage.findConversation({
            project: registration.project,
            comm: target.comm,
            account_label: registration.account_label,
            chat_native_id: target.chat_native_id,
            thread_native_id: target.thread_native_id ?? null,
        });
        if (!conversation) {
            const created = {
                schema_version: SCHEMA_VERSION_CONVERSATION,
                project: registration.project,
                comm: registration.comm,
                account_label: registration.account_label,
                chat_native_id: target.chat_native_id,
                thread_native_id: target.thread_native_id ?? null,
                conversation_id: conversationIdForPk({
                    project: registration.project,
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
}
export function conversationIdForPk(pk) {
    const raw = JSON.stringify([
        pk.project,
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
        account: conversation.account_label,
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
//# sourceMappingURL=bus.js.map
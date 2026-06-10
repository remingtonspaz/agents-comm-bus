import { normalizeProjectPath } from "../project-path.js";
export function durableInboundKey(entry) {
    return deliveryKey(entry.conversation.conversation_id, entry.message.message_id, entry.message.chat.comm, entry.message.chat.account);
}
export function deliveryKeyFromRow(row) {
    return deliveryKey(row.conversation_id, row.message_id, row.comm, row.account);
}
function deliveryKey(conversationId, messageId, comm, account) {
    return `${conversationId}::${messageId}::${comm}::${account}`;
}
export function queueHasDurableKey(queue, key) {
    return queue.some((entry) => durableInboundKey(entry) === key);
}
export function deliveryRowFromEntry(entry, enqueuedAt) {
    return {
        conversation_id: entry.conversation.conversation_id,
        message_id: entry.message.message_id,
        comm: entry.message.chat.comm,
        account: entry.message.chat.account,
        project: normalizeProjectPath(entry.conversation.project),
        agent: entry.conversation.agent,
        enqueued_at: enqueuedAt,
    };
}
export async function acknowledgePendingInboundEntries(storage, entries) {
    if (entries.length === 0)
        return;
    const keys = entries.map((entry) => ({
        conversation_id: entry.conversation.conversation_id,
        message_id: entry.message.message_id,
        comm: entry.message.chat.comm,
        account: entry.message.chat.account,
    }));
    await storage.acknowledgePendingInboundDeliveries(keys);
}
export async function removePendingInboundEntries(storage, queue, entries) {
    if (entries.length === 0)
        return;
    await acknowledgePendingInboundEntries(storage, entries);
    removePendingInboundFromMemory(queue, entries);
}
function removePendingInboundFromMemory(queue, entries) {
    const keys = new Set(entries.map((entry) => durableInboundKey(entry)));
    for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (keys.has(durableInboundKey(queue[i]))) {
            queue.splice(i, 1);
        }
    }
}
/**
 * Select pending-inbound entries matching the same comm/account filters as
 * `drainPendingInbound`, without mutating the queue.
 */
export function selectPendingInboundForDrain(queue, params = {}) {
    const raw = params?.comm;
    const commFilter = typeof raw === "string" && raw.length > 0 ? raw : null;
    const owned = params?.ownedAccountKeys instanceof Set
        ? params.ownedAccountKeys
        : null;
    if (!commFilter && owned === null) {
        return [...queue];
    }
    const selected = [];
    for (const entry of queue) {
        if (commFilter && entry.message.chat.comm !== commFilter)
            continue;
        if (owned !== null && !owned.has(pendingAccountKey(entry)))
            continue;
        selected.push(entry);
    }
    return selected;
}
/**
 * Daemon IPC drain path: select, acknowledge durable rows, then remove from memory.
 */
export async function drainAndAcknowledgePendingInbound(storage, queue, params = {}) {
    const selected = selectPendingInboundForDrain(queue, params);
    await removePendingInboundEntries(storage, queue, selected);
    return selected;
}
function pendingAccountKey(entry) {
    return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}
export async function rehydratePendingInboundForScope(input) {
    const project = normalizeProjectPath(input.project);
    const rows = await input.storage.listPendingInboundDeliveries({
        project,
        agent: input.agent,
    });
    let rehydrated = 0;
    for (const row of rows) {
        const key = deliveryKeyFromRow(row);
        if (queueHasDurableKey(input.queue, key))
            continue;
        const conversation = await input.storage.getConversation(row.conversation_id);
        if (!conversation) {
            await auditReplayMiss(input.audit, row, "conversation_not_found");
            continue;
        }
        const message = await findInboundTranscriptMessage(input.transcripts, row.conversation_id, row.message_id);
        if (!message) {
            await auditReplayMiss(input.audit, row, "transcript_payload_missing");
            continue;
        }
        if (message.chat.comm !== row.comm ||
            message.chat.account !== row.account) {
            await auditReplayMiss(input.audit, row, "transcript_key_mismatch");
            continue;
        }
        input.queue.push({ message, conversation });
        rehydrated += 1;
    }
    return rehydrated;
}
async function findInboundTranscriptMessage(transcripts, conversationId, messageId) {
    for await (const entry of transcripts.read(conversationId)) {
        if (entry.direction !== "inbound" || entry.message_id !== messageId)
            continue;
        return entry.payload;
    }
    return null;
}
async function auditReplayMiss(audit, row, reason) {
    await audit
        .append({
        timestamp: Date.now(),
        kind: "durable_inbound_replay_miss",
        agent: row.agent,
        conversation_id: row.conversation_id,
        detail: {
            message_id: row.message_id,
            comm: row.comm,
            account: row.account,
            project: row.project,
            reason,
        },
    })
        .catch(() => { });
}
//# sourceMappingURL=durable-inbound.js.map
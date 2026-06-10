import type {
  AgentId,
  AuditStore,
  CommId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  Storage,
  TranscriptStore,
} from "agents-comm-bus-core";

import { normalizeProjectPath } from "../project-path.js";
import type { PendingInboundEntry } from "./pending-inbound.js";

export interface PendingInboundDeliveryKey {
  conversation_id: ConversationId;
  message_id: MessageId;
  comm: CommId;
  account: string;
}

export interface PendingInboundDeliveryRow extends PendingInboundDeliveryKey {
  project: string;
  agent: AgentId;
  enqueued_at: number;
}

export function durableInboundKey(entry: PendingInboundEntry): string {
  return deliveryKey(
    entry.conversation.conversation_id,
    entry.message.message_id,
    entry.message.chat.comm,
    entry.message.chat.account,
  );
}

export function deliveryKeyFromRow(row: PendingInboundDeliveryRow): string {
  return deliveryKey(row.conversation_id, row.message_id, row.comm, row.account);
}

function deliveryKey(
  conversationId: ConversationId,
  messageId: MessageId,
  comm: CommId,
  account: string,
): string {
  return `${conversationId}::${messageId}::${comm}::${account}`;
}

export function queueHasDurableKey(
  queue: readonly PendingInboundEntry[],
  key: string,
): boolean {
  return queue.some((entry) => durableInboundKey(entry) === key);
}

export function deliveryRowFromEntry(
  entry: PendingInboundEntry,
  enqueuedAt: number,
): PendingInboundDeliveryRow {
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

export async function acknowledgePendingInboundEntries(
  storage: Storage,
  entries: readonly PendingInboundEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const keys: PendingInboundDeliveryKey[] = entries.map((entry) => ({
    conversation_id: entry.conversation.conversation_id,
    message_id: entry.message.message_id,
    comm: entry.message.chat.comm,
    account: entry.message.chat.account,
  }));
  await storage.acknowledgePendingInboundDeliveries(keys);
}

export async function removePendingInboundEntries(
  storage: Storage,
  queue: PendingInboundEntry[],
  entries: readonly PendingInboundEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await acknowledgePendingInboundEntries(storage, entries);
  removePendingInboundFromMemory(queue, entries);
}

function removePendingInboundFromMemory(
  queue: PendingInboundEntry[],
  entries: readonly PendingInboundEntry[],
): void {
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
export function selectPendingInboundForDrain(
  queue: readonly PendingInboundEntry[],
  params: Record<string, unknown> | undefined = {},
): PendingInboundEntry[] {
  const raw = params?.comm;
  const commFilter = typeof raw === "string" && raw.length > 0 ? raw : null;
  const owned = params?.ownedAccountKeys instanceof Set
    ? (params.ownedAccountKeys as Set<string>)
    : null;
  if (!commFilter && owned === null) {
    return [...queue];
  }
  const selected: PendingInboundEntry[] = [];
  for (const entry of queue) {
    if (commFilter && entry.message.chat.comm !== commFilter) continue;
    if (owned !== null && !owned.has(pendingAccountKey(entry))) continue;
    selected.push(entry);
  }
  return selected;
}

/**
 * Daemon IPC drain path: select, acknowledge durable rows, then remove from memory.
 */
export async function drainAndAcknowledgePendingInbound(
  storage: Storage,
  queue: PendingInboundEntry[],
  params: Record<string, unknown> | undefined = {},
): Promise<PendingInboundEntry[]> {
  const selected = selectPendingInboundForDrain(queue, params);
  await removePendingInboundEntries(storage, queue, selected);
  return selected;
}

function pendingAccountKey(entry: PendingInboundEntry): string {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}

export async function rehydratePendingInboundForScope(input: {
  storage: Storage;
  transcripts: TranscriptStore;
  audit: AuditStore;
  queue: PendingInboundEntry[];
  project: string;
  agent: AgentId;
}): Promise<number> {
  const project = normalizeProjectPath(input.project);
  const rows = await input.storage.listPendingInboundDeliveries({
    project,
    agent: input.agent,
  });
  let rehydrated = 0;
  for (const row of rows) {
    const key = deliveryKeyFromRow(row);
    if (queueHasDurableKey(input.queue, key)) continue;

    const conversation = await input.storage.getConversation(row.conversation_id);
    if (!conversation) {
      await auditReplayMiss(input.audit, row, "conversation_not_found");
      continue;
    }

    const message = await findInboundTranscriptMessage(
      input.transcripts,
      row.conversation_id,
      row.message_id,
    );
    if (!message) {
      await auditReplayMiss(input.audit, row, "transcript_payload_missing");
      continue;
    }

    if (
      message.chat.comm !== row.comm ||
      message.chat.account !== row.account
    ) {
      await auditReplayMiss(input.audit, row, "transcript_key_mismatch");
      continue;
    }

    input.queue.push({ message, conversation });
    rehydrated += 1;
  }
  return rehydrated;
}

async function findInboundTranscriptMessage(
  transcripts: TranscriptStore,
  conversationId: ConversationId,
  messageId: MessageId,
): Promise<Message | null> {
  for await (const entry of transcripts.read(conversationId)) {
    if (entry.direction !== "inbound" || entry.message_id !== messageId) continue;
    return entry.payload as Message;
  }
  return null;
}

async function auditReplayMiss(
  audit: AuditStore,
  row: PendingInboundDeliveryRow,
  reason: string,
): Promise<void> {
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
    .catch(() => {});
}

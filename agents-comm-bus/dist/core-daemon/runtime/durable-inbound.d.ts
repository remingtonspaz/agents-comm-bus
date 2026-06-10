import type { AgentId, AuditStore, CommId, ConversationId, MessageId, Storage, TranscriptStore } from "agents-comm-bus-core";
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
export declare function durableInboundKey(entry: PendingInboundEntry): string;
export declare function deliveryKeyFromRow(row: PendingInboundDeliveryRow): string;
export declare function queueHasDurableKey(queue: readonly PendingInboundEntry[], key: string): boolean;
export declare function deliveryRowFromEntry(entry: PendingInboundEntry, enqueuedAt: number): PendingInboundDeliveryRow;
export declare function acknowledgePendingInboundEntries(storage: Storage, entries: readonly PendingInboundEntry[]): Promise<void>;
export declare function removePendingInboundEntries(storage: Storage, queue: PendingInboundEntry[], entries: readonly PendingInboundEntry[]): Promise<void>;
/**
 * Select pending-inbound entries matching the same comm/account filters as
 * `drainPendingInbound`, without mutating the queue.
 */
export declare function selectPendingInboundForDrain(queue: readonly PendingInboundEntry[], params?: Record<string, unknown> | undefined): PendingInboundEntry[];
/**
 * Daemon IPC drain path: select, acknowledge durable rows, then remove from memory.
 */
export declare function drainAndAcknowledgePendingInbound(storage: Storage, queue: PendingInboundEntry[], params?: Record<string, unknown> | undefined): Promise<PendingInboundEntry[]>;
export declare function rehydratePendingInboundForScope(input: {
    storage: Storage;
    transcripts: TranscriptStore;
    audit: AuditStore;
    queue: PendingInboundEntry[];
    project: string;
    agent: AgentId;
}): Promise<number>;
//# sourceMappingURL=durable-inbound.d.ts.map
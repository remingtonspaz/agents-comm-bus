import type { AuditEvent, AuditStore, ConversationId, Message } from "agents-comm-bus-core";
export declare class JsonlAuditStore implements AuditStore {
    private readonly root;
    constructor(root: string);
    append(event: AuditEvent): Promise<void>;
    pathFor(timestamp: number): string;
    hasInboundReceived(conversation_id: ConversationId, message: Pick<Message, "platform_message_id">, auditTimestamp?: number): Promise<boolean>;
}
//# sourceMappingURL=audit.d.ts.map
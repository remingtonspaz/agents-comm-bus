import type { AuditEvent, AuditStore } from "../../../agents-comm-bus-core/dist/storage/audit-store.js";
export declare class JsonlAuditStore implements AuditStore {
    private readonly root;
    constructor(root: string);
    append(event: AuditEvent): Promise<void>;
    pathFor(timestamp: number): string;
}
//# sourceMappingURL=audit.d.ts.map
import type { QueryId, SessionId } from "../../../agents-comm-bus-core/dist/types.js";
import type { LegacyPendingPermission, LegacyStateFile } from "./legacy-readers.js";
import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "./legacy-readers.js";
export interface ImportedPendingPermissionQuery {
    query_id: QueryId;
    agent: string;
    session: SessionId;
    kind: "approval" | "choice";
    prompt_text: string;
    created_at: number;
    ttl_seconds: number;
    chat_native_id: string | null;
    thread_native_id: string | null;
    source_file: string;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export type ImportPendingPermissionResult = {
    status: "imported";
    record: ImportedPendingPermissionQuery;
    audit: TransitionPendingAudit;
} | {
    status: "skipped";
    reason: string;
    source_file: string;
    audit: TransitionPendingAudit;
};
export interface TransitionPendingAudit {
    kind: "legacy_state_imported" | "legacy_state_skipped";
    source: "pending-permission";
    path: string;
    reason?: string;
    detail: Record<string, unknown>;
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface ImportPendingPermissionOptions {
    sessionId: SessionId;
    now?: number;
    ttlSeconds?: number;
}
export declare function importPendingPermission(file: LegacyStateFile<LegacyPendingPermission>, options: ImportPendingPermissionOptions): ImportPendingPermissionResult;
//# sourceMappingURL=import-pending-permission.d.ts.map
import type { AuditStore, Storage } from "agents-comm-bus-core";
import type { EnsureCommsForSession } from "../runtime/agent-bridge.js";
/** Default recency window for boot-time scope restore (24 hours). */
export declare const DEFAULT_BOOT_RESTORE_RECENCY_MS: number;
export interface BootScopeRestoreSummary {
    status: "skipped_paused" | "completed";
    candidates: number;
    restored: number;
    skipped_dead: number;
    skipped_stale: number;
    skipped_no_owner: number;
}
export interface BootScopeRestoreInput {
    stateRoot: string;
    storage: Storage;
    ensureCommsForSession: EnsureCommsForSession;
    audit?: AuditStore;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    recencyMs?: number;
    pathExists?: (path: string) => Promise<boolean>;
}
/**
 * AGE-55: on daemon boot, re-ensure comm scopes whose host owner process is
 * still alive. Best-effort and idempotent — never throws to the caller.
 */
export declare function runBootScopeRestore(input: BootScopeRestoreInput): Promise<BootScopeRestoreSummary>;
//# sourceMappingURL=boot-scope-restore.d.ts.map
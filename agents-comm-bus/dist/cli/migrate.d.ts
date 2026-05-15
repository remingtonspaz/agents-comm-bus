#!/usr/bin/env node
import { TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER } from "../migrations/legacy-readers.js";
export interface MigrateOptions {
    projectRoot: string;
    homeDir?: string;
    now?: number;
    confirmCredentials?: "none" | "all" | string[];
    ingestState?: boolean;
    outputJsonPath?: string;
}
export interface MigrationAuditEvent {
    kind: "migration_scan_started" | "migration_scan_completed" | "credential_candidate_found" | "credential_registration_accepted" | "credential_registration_skipped" | "legacy_state_imported" | "legacy_state_skipped";
    timestamp: number;
    detail: Record<string, unknown>;
    transition?: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease?: typeof TRANSITION_CLEANUP_RELEASE;
}
export interface MigrationResult {
    schema_version: 1;
    started_at: number;
    completed_at: number;
    project_root: string;
    home_dir: string;
    credentials: Array<{
        agent: string;
        path: string;
        scope: string;
        hasBotToken: boolean;
        userIds: string[];
        credentialRef: string;
        confirmed: boolean;
    }>;
    state_ingestion: {
        mode: "read-only" | "disabled";
        last_chat: unknown[];
        pending_permission: unknown[];
        queue_files_seen: number;
    };
    audit_events: MigrationAuditEvent[];
    warnings: string[];
    transition: typeof TRANSITION_ONLY_MARKER;
    cleanupRelease: typeof TRANSITION_CLEANUP_RELEASE;
}
export declare function runMigration(options: MigrateOptions): MigrationResult;
export declare function parseMigrateArgs(argv: string[]): MigrateOptions;
//# sourceMappingURL=migrate.d.ts.map
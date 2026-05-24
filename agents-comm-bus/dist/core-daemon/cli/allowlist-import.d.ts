export interface ImportFromEnvOptions {
    comm?: string;
}
export interface ImportFromFilesOptions {
    comm?: string;
    dryRun?: boolean;
}
export interface ImportResult {
    comm: string;
    added: number;
    skipped: number;
    details: Array<{
        scope: "global" | "per-bot";
        bot_user_id?: string;
        sender_id: string;
        status: "added" | "duplicate" | "would-add";
    }>;
}
/**
 * Read `process.env.TELEGRAM_USER_ID` CSV and seed `allowlist_global` rows
 * for the given comm. Idempotent — PK collisions count as "duplicate". The
 * env var continues to flow into the union at adapter attach time; this
 * just persists a snapshot.
 */
export declare function allowlistImportFromEnv(options?: ImportFromEnvOptions): Promise<ImportResult>;
/**
 * Walk all account_registrations whose `credentials_ref` is `file:<path>`
 * and try to read the `userId` field (string, number, or array) out of
 * that JSON file. Each id becomes an `allowlist_per_bot` row scoped to
 * that registration's `bot_user_id`. Idempotent.
 */
export declare function allowlistImportFromFiles(options?: ImportFromFilesOptions): Promise<ImportResult>;
//# sourceMappingURL=allowlist-import.d.ts.map
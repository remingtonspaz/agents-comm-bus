export interface ReloadResult {
    attempted: boolean;
    ok?: boolean;
    reason?: string;
    summary?: unknown;
}
export interface ForceCredentialRefreshTarget {
    comm: string;
    accountId: string;
}
/**
 * Best-effort hot-reload trigger for the CLI's account-add / account-remove
 * commands. Reads the daemon's discovery files and, if a daemon is alive,
 * fires `reload_registrations` over a one-shot WS connection. If no daemon
 * is running (or the port file is stale), returns `{ attempted: false }`
 * so the caller can print "the change takes effect on next daemon spawn"
 * instead of throwing.
 */
export declare function reloadDaemonRegistrations(options?: {
    timeoutMs?: number;
    forceCredentialRefresh?: ForceCredentialRefreshTarget[];
}): Promise<ReloadResult>;
//# sourceMappingURL=reload-helper.d.ts.map
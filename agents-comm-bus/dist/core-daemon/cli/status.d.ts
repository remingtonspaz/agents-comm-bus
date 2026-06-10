import type { DaemonStatusSummary } from "../daemon.js";
export interface DaemonStatusSnapshot {
    daemon: {
        reachable: boolean;
        pid?: number;
        port?: number;
        version?: string;
        protocol_version?: string;
        reason?: string;
    };
    runtime?: DaemonStatusSummary;
    comm_leases: Array<{
        comm: string;
        resource_id: string;
        pid: number;
        authority_rank: string;
    }>;
    conversations: Array<{
        conversation_id: string;
        agent: string;
        comm: string;
        chat_native_id: string;
        last_inbound_at: number | null;
        last_outbound_at: number | null;
    }>;
    watchers: Array<{
        session_key: string;
        pid: number | null;
    }>;
}
export declare function daemonStatus(options?: {
    stateRoot?: string;
    discoveryRoot?: string;
    timeoutMs?: number;
}): Promise<DaemonStatusSnapshot>;
export declare function formatDaemonStatus(snapshot: DaemonStatusSnapshot): string;
export declare function leasePathFor(comm: string, resourceId: string, homeDir?: string): string;
//# sourceMappingURL=status.d.ts.map
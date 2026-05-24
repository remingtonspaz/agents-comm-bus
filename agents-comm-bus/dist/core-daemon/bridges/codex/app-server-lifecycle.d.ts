import type { SessionId } from "agents-comm-bus-core";
export interface ManagedAppServerState {
    sessionId?: string;
    appServerUrl?: string;
    appServerPid?: number;
    appServerTerminalPid?: number;
    wrapperPath?: string;
    stoppedAt?: string;
    stoppedBy?: string;
}
export interface ProcessManager {
    commandLine(pid: number): Promise<string | null>;
    descendants?(pid: number): Promise<number[]>;
    kill(pid: number): Promise<boolean>;
}
export interface ManagedAppServerCleanupResult {
    ok: boolean;
    statePath: string;
    appServerStopped?: number;
    terminalStopped?: number;
    reason?: string;
}
export interface ManagedAppServerCleanupOptions {
    stateRoot?: string;
    processManager?: ProcessManager;
    now?: () => Date;
}
export declare function cleanupManagedCodexAppServer(session: SessionId, options?: ManagedAppServerCleanupOptions): Promise<ManagedAppServerCleanupResult>;
export declare function managedCodexAppServerStatePath(session: SessionId, stateRoot?: string): string;
//# sourceMappingURL=app-server-lifecycle.d.ts.map
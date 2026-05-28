export interface StatePathOptions {
    homeDir?: string;
    stateRoot?: string;
}
export interface ConversationPathOptions extends StatePathOptions {
    conversationId: string;
}
export interface AgentsCommBusPaths {
    root: string;
    database: string;
    databaseWal: string;
    databaseShm: string;
    auditDir: string;
    chatsDir: string;
    tokensDir: string;
    pidFile: string;
    portFile: string;
    spawnLock: string;
}
export interface ConversationPaths {
    conversationDir: string;
    transcript: string;
    attachmentsDir: string;
}
export interface TokenFilePathOptions extends StatePathOptions {
    comm: string;
    project: string;
    agent: string;
    accountId: string;
}
export declare function stateRoot(options?: StatePathOptions): string;
export declare function resolveStatePaths(options?: StatePathOptions): AgentsCommBusPaths;
export declare function resolveConversationPaths(options: ConversationPathOptions): ConversationPaths;
export declare function resolveTokenFilePath(options: TokenFilePathOptions): string;
//# sourceMappingURL=paths.d.ts.map
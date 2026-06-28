import type { CommId } from "agents-comm-bus-core";
export declare function writeCredentialsFile(options: {
    stateRoot?: string;
    comm: CommId;
    project: string;
    agent: string;
    accountId: string;
    credentials: Record<string, unknown>;
}): Promise<string>;
export declare function writeTokenFile(options: {
    stateRoot?: string;
    comm: CommId;
    project: string;
    agent: string;
    accountId: string;
    botToken: string;
    userId?: string[];
}): Promise<string>;
//# sourceMappingURL=token-file.d.ts.map
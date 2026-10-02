import type { AgentId } from "agents-comm-bus-core";
export interface HerdrIdentity {
    type: "herdr";
    agent: AgentId;
    pane_id: string;
    socket_path: string;
    workspace_id?: string;
    tab_id?: string;
    bin_path?: string;
}
export type HerdrWakeStrict = "herdr";
export declare function normalizeHerdrSocketPath(socketPath: string): string;
export declare function herdrSessionId(identity: HerdrIdentity): string;
export declare function parseHerdrIdentity(raw: unknown): HerdrIdentity | null;
export declare function parseHerdrIdentityJson(json: string | null | undefined): HerdrIdentity | null;
export interface HerdrCliError {
    ok: false;
    code: string;
    message: string;
}
export type HerdrCliResult<T> = {
    ok: true;
    data: T;
} | HerdrCliError;
export interface HerdrAgentInfo {
    pane_id: string;
    agent: string;
    agent_status?: string;
    cwd?: string;
    name?: string;
}
export type HerdrExecFile = (file: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare class HerdrClient {
    private readonly identity;
    private readonly options;
    constructor(identity: HerdrIdentity, options?: {
        execFile?: HerdrExecFile;
        env?: NodeJS.ProcessEnv;
        resolveBin?: (identity: HerdrIdentity, env: NodeJS.ProcessEnv) => string;
    });
    agentGet(): Promise<HerdrCliResult<HerdrAgentInfo | null>>;
    agentPrompt(text: string): Promise<HerdrCliResult<unknown>>;
    agentSendKeys(...keys: string[]): Promise<HerdrCliResult<unknown>>;
    paneSendText(text: string): Promise<HerdrCliResult<unknown>>;
    private runJson;
}
export declare function resolveHerdrBin(identity: HerdrIdentity, env?: NodeJS.ProcessEnv): string;
export declare function validateHerdrIdentityAgent(client: HerdrClient, identity: HerdrIdentity): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
//# sourceMappingURL=herdr.d.ts.map
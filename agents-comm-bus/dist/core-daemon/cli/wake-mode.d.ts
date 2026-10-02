import type { AgentId } from "agents-comm-bus-core";
export declare function wakeModeSet(options: {
    agent: string;
    mode: "auto" | "native";
    project?: string;
}): Promise<{
    ok: true;
}>;
export declare function wakeModeGet(options: {
    agent: string;
    project?: string;
}): Promise<{
    ok: true;
    mode: "auto" | "native";
    source: {
        scope: "project" | "global" | "default";
        project: string;
    };
}>;
export declare function wakeModeClear(options: {
    agent: string;
    project?: string;
}): Promise<{
    ok: true;
}>;
export declare function wakeModeList(): Promise<{
    ok: true;
    rows: Array<{
        project: string;
        agent: AgentId;
        mode: "auto" | "native";
        updated_at: number;
    }>;
}>;
//# sourceMappingURL=wake-mode.d.ts.map
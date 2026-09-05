import type { CodexAppServerClient } from "./app-server.js";
export type CodexWakeTargetProbeResult = {
    ok: true;
    appServerUrl: string;
    threadId: string;
    scanned: number;
} | {
    ok: false;
    reason: "probe_no_match" | "probe_ambiguous";
    scanned: number;
    matches: number;
    ports?: number[];
};
export interface ProbeCodexWakeTargetByCwdInput {
    project: string;
    portRange: {
        min: number;
        max: number;
    };
    clientFactory: (url: string) => CodexAppServerClient;
    perProbeTimeoutMs?: number;
    concurrency?: number;
}
export declare function probeCodexWakeTargetByCwd(input: ProbeCodexWakeTargetByCwdInput): Promise<CodexWakeTargetProbeResult>;
//# sourceMappingURL=wake-target-probe.d.ts.map
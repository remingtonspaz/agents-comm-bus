export declare const DEV_MARKER_NAME = ".agents-comm-bus-dev.json";
export interface DevConfigResult {
    env: Record<string, string>;
    status: "none" | "applied" | "rejected";
    reasons: string[];
}
export interface DevConfigDeps {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string;
}
export declare function resolveDevConfig(projectRoot: string, deps?: DevConfigDeps): DevConfigResult;
export declare function applyDevConfig(baseEnv: Record<string, string | undefined>, projectRoot: string, deps?: DevConfigDeps): {
    env: Record<string, string | undefined>;
    devConfig: DevConfigResult;
};
//# sourceMappingURL=dev-config-resolver.d.ts.map
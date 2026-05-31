import type { CommAdapterFactory } from "./comm-factory.js";
export interface CommAdapterLoadFailure {
    /** The adapter module (or, for the all-failed summary, the adapters dir). */
    modulePath: string;
    error: unknown;
}
export interface LoadCommAdapterFactoriesOptions {
    adaptersDir: string;
    /**
     * Called once per adapter that fails to load (import throw, missing
     * `createCommAdapterFactory`, or an invalid factory shape), and once more as a
     * loud summary if adapters were present but none loaded. The loader logs and
     * CONTINUES — one broken/incompatible adapter bundle must never block the
     * daemon from starting with the other comms (and the agent WS connection,
     * which is the daemon's whole job). Defaults to a `console.error` logger.
     */
    onError?: (failure: CommAdapterLoadFailure) => void;
}
export declare function loadCommAdapterFactories(options: LoadCommAdapterFactoriesOptions): Promise<CommAdapterFactory[]>;
//# sourceMappingURL=comm-adapter-loader.d.ts.map
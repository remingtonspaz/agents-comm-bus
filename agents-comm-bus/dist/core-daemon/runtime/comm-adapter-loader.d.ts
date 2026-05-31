import type { CommAdapterFactory } from "./comm-factory.js";
export interface LoadCommAdapterFactoriesOptions {
    adaptersDir: string;
}
export declare function loadCommAdapterFactories(options: LoadCommAdapterFactoriesOptions): Promise<CommAdapterFactory[]>;
//# sourceMappingURL=comm-adapter-loader.d.ts.map
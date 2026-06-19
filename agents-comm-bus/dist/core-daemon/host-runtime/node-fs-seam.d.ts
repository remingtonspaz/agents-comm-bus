import type { CentralState, CentralPaths, FsSeam } from "./reconcile-central-install.js";
export declare function createNodeFsSeam(): FsSeam;
export declare function createAtomicNodeFsSeam(): FsSeam;
export declare function readCentralState(stateRoot: string, comm: string): Promise<CentralState>;
export declare function resolveCentralPaths(stateRoot: string, comm: string): CentralPaths;
//# sourceMappingURL=node-fs-seam.d.ts.map